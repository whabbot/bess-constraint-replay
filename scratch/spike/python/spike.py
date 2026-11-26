#!/usr/bin/env python3
import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

BASE = "https://data.elexon.co.uk/bmrs/api/v1"
DATE = sys.argv[1] if len(sys.argv) > 1 else "2026-11-18"
TOL_MWH = 1e-4
REQUESTS = 0
LOCK = threading.Lock()


def bump():
    global REQUESTS
    with LOCK:
        REQUESTS += 1


def get_json(url):
    delay = 1.0
    last = "no response"
    for attempt in range(4):
        bump()
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "bess-constraint-replay-spike",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            last = f"{err.code} {err.read().decode()[:300]}"
            if err.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            raise SystemExit(f"GET {url}\n{last}")
        except urllib.error.URLError as err:
            last = str(err)
            if attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            raise SystemExit(f"GET {url}\n{last}")
    raise SystemExit(f"GET {url}\n{last}")


def rows_of(payload):
    if isinstance(payload, list):
        return payload
    return payload.get("data") or []


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso_z(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def last_sunday(year, month):
    if month == 12:
        cursor = datetime(year + 1, 1, 1)
    else:
        cursor = datetime(year, month + 1, 1)
    cursor -= timedelta(days=1)
    while cursor.weekday() != 6:
        cursor -= timedelta(days=1)
    return cursor


def london_offset_hours(dt):
    start = datetime(dt.year, 3, last_sunday(dt.year, 3).day, 1, tzinfo=timezone.utc)
    end = datetime(dt.year, 10, last_sunday(dt.year, 10).day, 1, tzinfo=timezone.utc)
    if start <= dt < end:
        return 1
    return 0


def settlement_midnight(date):
    year, month, day = map(int, date.split("-"))
    noon = datetime(year, month, day, 12, tzinfo=timezone.utc)
    offset = london_offset_hours(noon)
    return datetime(year, month, day, tzinfo=timezone.utc) - timedelta(hours=offset)


def next_date(date):
    year, month, day = map(int, date.split("-"))
    return (datetime(year, month, day) + timedelta(days=1)).date().isoformat()


def prev_date(date):
    year, month, day = map(int, date.split("-"))
    return (datetime(year, month, day) - timedelta(days=1)).date().isoformat()


def sp_bounds(date, sp):
    start = settlement_midnight(date) + timedelta(minutes=30 * (sp - 1))
    return start, start + timedelta(minutes=30)


def day_length_ok(date):
    return settlement_midnight(next_date(date)) - settlement_midnight(date) == timedelta(hours=24)


def segments_from_rows(raw_rows):
    segs = []
    for row in raw_rows:
        start = parse_time(row["timeFrom"])
        end = parse_time(row["timeTo"])
        if end <= start:
            continue
        segs.append((start, end, float(row["levelFrom"]), float(row["levelTo"])))
    segs.sort()
    return segs


def level_at(segs, moment):
    for start, end, left, right in segs:
        if start <= moment <= end:
            if end == start:
                return left
            frac = (moment - start) / (end - start)
            return left + (right - left) * frac
    return None


def is_so(value):
    return value is True or value == "true"


def profile_rows(group):
    amended = [row for row in group if row.get("amendmentFlag") not in (None, "ORI")]
    if amended:
        return amended
    return group


def build_acceptances(raw_rows):
    grouped = defaultdict(list)
    for row in raw_rows:
        grouped[row["acceptanceNumber"]].append(row)
    accs = []
    for number, group in grouped.items():
        use = profile_rows(group)
        segs = segments_from_rows(use)
        if not segs:
            continue
        accs.append(
            {
                "id": number,
                "time": parse_time(use[0]["acceptanceTime"]),
                "so": is_so(use[0].get("soFlag")),
                "segs": segs,
                "start": min(seg[0] for seg in segs),
                "end": max(seg[1] for seg in segs),
            }
        )
    accs.sort(key=lambda item: (item["time"], item["id"]))
    return accs


def operative_level(accs, index, moment, pn_segs):
    chosen = None
    for earlier in accs[:index]:
        if earlier["start"] <= moment <= earlier["end"]:
            level = level_at(earlier["segs"], moment)
            if level is not None:
                chosen = level
    if chosen is None:
        fpn = level_at(pn_segs, moment)
        return 0.0 if fpn is None else fpn
    return chosen


def integrate_bid_offer(accs, acc, pn_segs, sp_start, sp_end):
    left = max(acc["start"], sp_start)
    right = min(acc["end"], sp_end)
    if right <= left:
        return 0.0, 0.0
    index = accs.index(acc)
    knots = {left, right}
    sources = [acc["segs"], pn_segs]
    sources.extend(earlier["segs"] for earlier in accs[:index])
    for segs in sources:
        for start, end, _left, _right in segs:
            if left < start < right:
                knots.add(start)
            if left < end < right:
                knots.add(end)
    times = sorted(knots)
    bid = 0.0
    offer = 0.0
    for t0, t1 in zip(times, times[1:]):
        mid = t0 + (t1 - t0) / 2
        new_level = level_at(acc["segs"], mid)
        if new_level is None:
            continue
        delta = new_level - operative_level(accs, index, mid, pn_segs)
        mwh = delta * (t1 - t0).total_seconds() / 3600
        if mwh < 0:
            bid += mwh
        else:
            offer += mwh
    return bid, offer


def fetch_dataset_period(dataset, sp):
    url = f"{BASE}/datasets/{dataset}?settlementDate={DATE}&settlementPeriod={sp}"
    return rows_of(get_json(url))


def fetch_window(kind, bm_unit, start, end):
    query = urllib.parse.urlencode(
        {"from": iso_z(start), "to": iso_z(end), "bmUnit": bm_unit, "dataset": "PN"}
    )
    if kind == "boalf":
        query = urllib.parse.urlencode(
            {"from": iso_z(start), "to": iso_z(end), "bmUnit": bm_unit}
        )
        url = f"{BASE}/datasets/BOALF?{query}"
    else:
        url = f"{BASE}/balancing/physical?{query}"
    return rows_of(get_json(url))


def dedupe_rows(raw_rows, keys):
    seen = set()
    out = []
    for row in raw_rows:
        marker = tuple(row.get(key) for key in keys)
        if marker in seen:
            continue
        seen.add(marker)
        out.append(row)
    return out


def fmt(value):
    return f"{value:.6f}"


def calendar_check():
    july = sp_bounds("2026-07-01", 1)[0]
    november = sp_bounds("2026-11-18", 1)[0]
    expect_july = datetime(2026, 6, 30, 23, tzinfo=timezone.utc)
    expect_nov = datetime(2026, 11, 18, 0, tzinfo=timezone.utc)
    if july != expect_july or november != expect_nov:
        raise SystemExit(f"calendar check failed july={july} november={november}")
    print(f"calendar_check july_sp1_start {iso_z(july)}")
    print(f"calendar_check november_sp1_start {iso_z(november)}")
    if not day_length_ok(DATE):
        raise SystemExit(
            f"{DATE} is a clock-change settlement day. This spike does not handle 46 or 50 periods."
        )


def load_proxy_units():
    reference = rows_of(get_json(f"{BASE}/reference/bmunits/all"))
    by_ng = {}
    by_ex = {}
    for unit in reference:
        if unit.get("nationalGridBmUnit") and unit["nationalGridBmUnit"] not in by_ng:
            by_ng[unit["nationalGridBmUnit"]] = unit
        if unit.get("elexonBmUnit") and unit["elexonBmUnit"] not in by_ex:
            by_ex[unit["elexonBmUnit"]] = unit
    jobs = [("MDO", sp) for sp in range(1, 49)] + [("MDB", sp) for sp in range(1, 49)]
    found = defaultdict(set)
    with ThreadPoolExecutor(max_workers=6) as pool:
        mapped = pool.map(lambda job: (job, fetch_dataset_period(*job)), jobs)
        for (dataset, _sp), period_rows in mapped:
            for row in period_rows:
                found[row.get("nationalGridBmUnit")].add((dataset, row.get("bmUnit")))
    units = []
    unmatched = 0
    for ng, tags in found.items():
        unit = by_ng.get(ng)
        if unit is None:
            for _dataset, ex in tags:
                unit = by_ex.get(ex)
                if unit:
                    break
        if unit is None or unit.get("gspGroupId") not in ("_N", "_P"):
            if unit is None:
                unmatched += 1
            continue
        datasets = sorted({tag[0] for tag in tags})
        units.append(
            {
                "elexon": unit.get("elexonBmUnit"),
                "ng": unit.get("nationalGridBmUnit"),
                "gsp": unit.get("gspGroupId"),
                "gsp_name": unit.get("gspGroupName"),
                "fuel": unit.get("fuelType"),
                "name": unit.get("bmUnitName"),
                "party": unit.get("leadPartyName"),
                "bm_unit_type": unit.get("bmUnitType"),
                "datasets": datasets,
            }
        )
    units.sort(key=lambda item: item["elexon"] or "")
    return units, unmatched, len(found)


def windows_for(date):
    start = settlement_midnight(date)
    return [
        (start - timedelta(hours=12), start),
        (start, start + timedelta(hours=24)),
        (start + timedelta(hours=24), start + timedelta(hours=36)),
    ]


def load_unit(unit):
    elexon = unit["elexon"]
    main_start = settlement_midnight(DATE)
    main_rows = fetch_window("boalf", elexon, main_start, main_start + timedelta(hours=24))
    so_rows = [row for row in main_rows if is_so(row.get("soFlag"))]
    so_ids = {row.get("acceptanceNumber") for row in so_rows}
    detail = None
    if so_ids:
        bo_rows = []
        pn_rows = []
        for start, end in windows_for(DATE):
            bo_rows.extend(fetch_window("boalf", elexon, start, end))
            pn_rows.extend(fetch_window("pn", elexon, start, end))
        bo_rows = dedupe_rows(
            bo_rows,
            ["acceptanceNumber", "timeFrom", "timeTo", "levelFrom", "levelTo", "amendmentFlag"],
        )
        pn_rows = dedupe_rows(
            pn_rows, ["timeFrom", "timeTo", "levelFrom", "levelTo", "settlementPeriod", "settlementDate"]
        )
        boav = rows_of(
            get_json(
                f"{BASE}/balancing/settlement/acceptance/volumes/all/bid/{DATE}?bmUnit="
                + urllib.parse.quote(elexon)
            )
        )
        detail = {"bo": bo_rows, "pn": pn_rows, "boav": boav}
    return {**unit, "main_rows": len(main_rows), "so_acceptances": len(so_ids), "detail": detail}


def compare_unit(loaded):
    detail = loaded["detail"]
    pn_segs = segments_from_rows([row for row in detail["pn"] if row.get("dataset") == "PN"])
    accs = build_acceptances(detail["bo"])
    by_id = {acc["id"]: acc for acc in accs}
    matched = 0
    missing = 0
    worst = 0.0
    lines = []
    for row in sorted(detail["boav"], key=lambda item: (item["settlementPeriod"], item["acceptanceId"])):
        acc = by_id.get(row["acceptanceId"])
        published = float(row["totalVolumeAccepted"])
        if acc is None:
            missing += 1
            lines.append(
                f"  sp {row['settlementPeriod']} acceptance {row['acceptanceId']} published_mwh {fmt(published)} computed_mwh missing"
            )
            continue
        sp_start, sp_end = sp_bounds(row["settlementDate"], row["settlementPeriod"])
        bid, _offer = integrate_bid_offer(accs, acc, pn_segs, sp_start, sp_end)
        diff = abs(bid - published)
        worst = max(worst, diff)
        matched += 1
        lines.append(
            f"  sp {row['settlementPeriod']} acceptance {row['acceptanceId']} published_mwh {fmt(published)} computed_mwh {fmt(bid)}"
        )
    return {
        "matched": matched,
        "missing": missing,
        "worst": worst,
        "lines": lines,
        "accs": accs,
        "pn_keys": sorted(detail["pn"][0].keys()) if detail["pn"] else [],
        "boav": detail["boav"],
    }


def repeated_pairs(accs, boav):
    negative_ids = set()
    for row in boav:
        if float(row["totalVolumeAccepted"]) < 0:
            negative_ids.add(row["acceptanceId"])
    bids = [acc for acc in accs if acc["so"] and acc["id"] in negative_ids]
    bids.sort(key=lambda item: (item["time"], item["id"]))
    pairs = {3: 0, 6: 0, 12: 0}
    with_later = {3: 0, 6: 0, 12: 0}
    for i, earlier in enumerate(bids):
        later_hours = []
        for later in bids[i + 1 :]:
            hours = (later["time"] - earlier["time"]).total_seconds() / 3600
            if hours <= 0:
                continue
            later_hours.append(hours)
            for window in (3, 6, 12):
                if hours <= window:
                    pairs[window] += 1
        for window in (3, 6, 12):
            if any(hours <= window for hours in later_hours):
                with_later[window] += 1
    return len(bids), pairs, with_later


def price_index(price_rows):
    index = {}
    for row in price_rows:
        index[(row["bmUnit"], row["acceptanceNumber"], row["bidOfferPairId"])] = row
    return index


def cost_example(loaded, compared):
    detail = loaded["detail"]
    so_ids = {acc["id"] for acc in compared["accs"] if acc["so"]}
    candidates = [
        row
        for row in detail["boav"]
        if row["acceptanceId"] in so_ids and float(row["totalVolumeAccepted"]) < 0
    ]
    if not candidates:
        print("cost_example none")
        return
    def sort_key(row):
        acc = next(item for item in compared["accs"] if item["id"] == row["acceptanceId"])
        return (acc["time"], row["acceptanceId"], -abs(float(row["totalVolumeAccepted"])))

    chosen = sorted(candidates, key=sort_key)[0]
    signed = float(chosen["totalVolumeAccepted"])
    sp = chosen["settlementPeriod"]
    prices = rows_of(
        get_json(f"{BASE}/balancing/settlement/acceptances/all/{DATE}/{sp}")
    )
    offers = rows_of(
        get_json(f"{BASE}/balancing/settlement/acceptance/volumes/all/offer/{DATE}/{sp}")
    )
    index = price_index(prices)
    bid_component = 0.0
    priced_mwh = 0.0
    pair_bits = []
    pairs = chosen.get("pairVolumes") or {}
    for n in range(1, 7):
        raw = pairs.get(f"negative{n}")
        if raw is None or float(raw) == 0:
            continue
        volume = float(raw)
        price_row = index.get((chosen["bmUnit"], chosen["acceptanceId"], -n))
        if price_row is None or price_row.get("bidPrice") is None:
            pair_bits.append(f"pair -{n} mwh {fmt(volume)} bid_price missing")
            continue
        price = float(price_row["bidPrice"])
        bid_component += price * volume
        priced_mwh += volume
        pair_bits.append(f"pair -{n} mwh {fmt(volume)} bid_price {fmt(price)}")
    num = 0.0
    den = 0.0
    unpriced = 0
    for row in offers:
        offer_pairs = row.get("pairVolumes") or {}
        for n in range(1, 7):
            raw = offer_pairs.get(f"positive{n}")
            if raw is None or float(raw) == 0:
                continue
            volume = float(raw)
            price_row = index.get((row["bmUnit"], row["acceptanceId"], n))
            if price_row is None or price_row.get("offerPrice") is None:
                unpriced += 1
                continue
            num += float(price_row["offerPrice"]) * volume
            den += volume
    print("cost_example")
    print("label estimate of one system bid, not an attributed loop cost")
    print(f"bm_unit {chosen['bmUnit']}")
    print(f"acceptance {chosen['acceptanceId']}")
    print(f"settlement_period {sp}")
    print(f"signed_bid_mwh {fmt(signed)}")
    for bit in pair_bits:
        print(f"  {bit}")
    if den == 0:
        print("offer_wavg_gbp_per_mwh missing")
        print(f"unpriced_offer_pairs {unpriced}")
        return
    wavg = num / den
    replacement = wavg * (-signed)
    net = bid_component + replacement
    print(f"bid_component_gbp {fmt(bid_component)}")
    print(f"offer_wavg_gbp_per_mwh {fmt(wavg)}")
    print(f"offer_mwh_in_sp {fmt(den)}")
    print(f"unpriced_offer_pairs {unpriced}")
    print(f"replacement_gbp {fmt(replacement)}")
    print(f"net_gbp {fmt(net)}")
    print(
        "convention bid_component = sum(bid_price * signed_pair_mwh); replacement = offer_wavg * (-signed_bid_mwh); net = bid_component + replacement"
    )
    print(
        "sign_note the Nov 2026 NESO appendix says the bid term is typically a negative cost that offsets replacement. This line follows that reading. It is an estimate."
    )


def neso_section():
    package = get_json(
        "https://api.neso.energy/api/3/action/package_show?id=day-ahead-constraint-flows-and-limits"
    )
    resource = next(
        item
        for item in package["result"]["resources"]
        if item.get("datastore_active")
    )
    rid = resource["id"]
    meta = get_json(
        f"https://api.neso.energy/api/3/action/datastore_search?resource_id={rid}&limit=0"
    )
    fields = [field["id"] for field in meta["result"]["fields"] if field["id"] != "_id"]
    date_field = next(name for name in fields if "Date" in name)
    group_field = next(name for name in fields if "Constraint" in name)
    sql = (
        f'SELECT "{group_field}" AS grp, COUNT(*) AS n FROM "{rid}" '
        f'WHERE "{date_field}" >= \'{DATE}T00:00:00\' AND "{date_field}" < \'{next_date(DATE)}T00:00:00\' '
        f'GROUP BY "{group_field}" ORDER BY "{group_field}"'
    )
    query = get_json(
        "https://api.neso.energy/api/3/action/datastore_search_sql?"
        + urllib.parse.urlencode({"sql": sql})
    )
    records = query["result"]["records"]
    total = sum(int(row["n"]) for row in records)
    print("neso_dataset day-ahead-constraint-flows-and-limits")
    print("neso_fields " + ", ".join(fields))
    print(f"neso_rows_on_date {total}")
    print("neso_constraint_groups " + " ".join(row["grp"] for row in records))
    print("neso_bm_unit_column no")
    ancillary = get_json(
        "https://api.neso.energy/api/3/action/package_show?id=dynamic-containment-data"
    )
    names = [
        f"{item.get('format')}:{item.get('name')}" for item in ancillary["result"]["resources"]
    ]
    print("ancillary_package dynamic-containment-data")
    print("ancillary_resources " + " | ".join(names))
    print(
        "ancillary_gap auction results are not a unit-level negative DC Low, DM Low, DR Low, or Negative Quick Reserve position for the next 3h. That flag is unknown."
    )


def main():
    started = time.time()
    print("spike bess-constraint-replay")
    print("language python")
    print("throwaway yes")
    print("command python3 scratch/spike/python/spike.py")
    print(f"settlement_date {DATE}")
    print(f"started_utc {iso_z(datetime.now(timezone.utc))}")
    print(
        "proxy units that submit MDO or MDB on this date, sit in GSP _N or _P, and have a soFlag acceptance. This is a proxy, not an official constraint map."
    )
    calendar_check()
    units, unmatched, mdo_mdb_ids = load_proxy_units()
    print(f"mdo_or_mdb_bm_units {mdo_mdb_ids}")
    print(f"mdo_mdb_ids_missing_from_reference {unmatched}")
    print(f"proxy_candidates_scottish_mdo_or_mdb {len(units)}")
    loaded = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        loaded = list(pool.map(load_unit, units))
    loaded.sort(key=lambda item: item["elexon"] or "")
    detailed = [item for item in loaded if item["so_acceptances"]]
    print(f"proxy_units_with_soflag {len(detailed)}")
    for item in loaded:
        fuel = item["fuel"] if item["fuel"] is not None else "null"
        print(
            f"candidate {item['elexon']} ng {item['ng']} gsp {item['gsp']} fuel {fuel} type {item['bm_unit_type']} datasets {'+'.join(item['datasets'])} so_acceptances {item['so_acceptances']} name {item['name']} party {item['party']}"
        )
    failed = False
    for item in detailed:
        compared = compare_unit(item)
        print(f"unit {item['elexon']} ng {item['ng']} gsp {item['gsp']}")
        print(f"boav_bid_rows {compared['matched'] + compared['missing']}")
        print(f"matched {compared['matched']}")
        print(f"missing_profile {compared['missing']}")
        print(f"worst_abs_mwh {compared['worst']:.3e}")
        print(f"pn_keys {' '.join(compared['pn_keys'])}")
        for line in compared["lines"]:
            print(line)
        system_bids, pairs, with_later = repeated_pairs(compared["accs"], item["detail"]["boav"])
        print("loops_confirmed 0")
        print(
            "loops_reason public PN rows have no submission timestamp, so a later positive FPN change cannot be timed against the system bid"
        )
        print(f"system_bid_acceptances {system_bids}")
        print(f"system_bids_with_later_bid_within_3h {with_later[3]}")
        print(f"system_bids_with_later_bid_within_6h {with_later[6]}")
        print(f"system_bids_with_later_bid_within_12h {with_later[12]}")
        print(f"repeated_bid_pairs_within_3h {pairs[3]}")
        print(f"repeated_bid_pairs_within_6h {pairs[6]}")
        print(f"repeated_bid_pairs_within_12h {pairs[12]}")
        print(
            "repeated_bid_pairs_label ordered pairs of soFlag acceptances with negative published bid volume. Not confirmed loops."
        )
        cost_example(item, compared)
        if compared["matched"] == 0 or compared["missing"] or compared["worst"] >= TOL_MWH:
            failed = True
    hist = rows_of(
        get_json(f"{BASE}/datasets/MDO?settlementDate=2025-12-03&settlementPeriod=20")
    )
    print(f"mdo_rows_2025_12_03_sp20 {len(hist)}")
    neso_section()
    elapsed = time.time() - started
    print(f"elapsed_s {elapsed:.1f}")
    print(f"http_requests {REQUESTS}")
    print(
        "elapsed_note elapsed_s is mostly HTTP round trips. It is not a language benchmark."
    )
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
