const BASE = "https://data.elexon.co.uk/bmrs/api/v1";
const DATE = process.argv[2] ?? "2026-11-18";
const TOL_MWH = 1e-4;
let REQUESTS = 0;

type Row = Record<string, unknown>;

interface Segment {
  start: number;
  end: number;
  left: number;
  right: number;
}

interface Acceptance {
  id: number;
  time: number;
  so: boolean;
  segs: Segment[];
  start: number;
  end: number;
}

interface ProxyUnit {
  elexon: string;
  ng: string;
  gsp: string;
  gspName: string;
  fuel: string | null;
  name: string;
  party: string;
  bmUnitType: string | null;
  datasets: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url: string): Promise<unknown> {
  let delay = 1000;
  let last = "no response";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    REQUESTS += 1;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "bess-constraint-replay-spike",
        },
      });
      if (!res.ok) {
        last = `${res.status} ${(await res.text()).slice(0, 300)}`;
        if ([429, 500, 502, 503].includes(res.status) && attempt < 3) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw new Error(`GET ${url}\n${last}`);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("GET ")) throw err;
      last = String(err);
      if (attempt < 3) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new Error(`GET ${url}\n${last}`);
    }
  }
  throw new Error(`GET ${url}\n${last}`);
}

function rowsOf(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload as Row[];
  const data = (payload as { data?: Row[] }).data;
  return data ?? [];
}

function parseTime(value: string): number {
  return Date.parse(value);
}

function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function lastSunday(year: number, month: number): number {
  const firstOfNext =
    month === 12
      ? new Date(Date.UTC(year + 1, 0, 1))
      : new Date(Date.UTC(year, month, 1));
  const cursor = new Date(firstOfNext.getTime() - 86_400_000);
  while (cursor.getUTCDay() !== 0) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor.getUTCDate();
}

function londonOffsetHours(ms: number): number {
  const year = new Date(ms).getUTCFullYear();
  const start = Date.UTC(year, 2, lastSunday(year, 3), 1);
  const end = Date.UTC(year, 9, lastSunday(year, 10), 1);
  if (ms >= start && ms < end) return 1;
  return 0;
}

function settlementMidnight(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const noon = Date.UTC(year, month - 1, day, 12);
  const offset = londonOffsetHours(noon);
  return Date.UTC(year, month - 1, day) - offset * 3_600_000;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function spBounds(date: string, sp: number): [number, number] {
  const start = settlementMidnight(date) + 30 * 60 * 1000 * (sp - 1);
  return [start, start + 30 * 60 * 1000];
}

function dayLengthOk(date: string): boolean {
  return settlementMidnight(shiftDate(date, 1)) - settlementMidnight(date) === 86_400_000;
}

function segmentsFromRows(rawRows: Row[]): Segment[] {
  const segs: Segment[] = [];
  for (const row of rawRows) {
    const start = parseTime(String(row.timeFrom));
    const end = parseTime(String(row.timeTo));
    if (end <= start) continue;
    segs.push({
      start,
      end,
      left: Number(row.levelFrom),
      right: Number(row.levelTo),
    });
  }
  segs.sort((a, b) => a.start - b.start || a.end - b.end);
  return segs;
}

function levelAt(segs: Segment[], moment: number): number | null {
  for (const seg of segs) {
    if (seg.start <= moment && moment <= seg.end) {
      if (seg.end === seg.start) return seg.left;
      const frac = (moment - seg.start) / (seg.end - seg.start);
      return seg.left + (seg.right - seg.left) * frac;
    }
  }
  return null;
}

function isSo(value: unknown): boolean {
  return value === true || value === "true";
}

function profileRows(group: Row[]): Row[] {
  const amended = group.filter(
    (row) => row.amendmentFlag !== undefined && row.amendmentFlag !== null && row.amendmentFlag !== "ORI",
  );
  if (amended.length) return amended;
  return group;
}

function buildAcceptances(rawRows: Row[]): Acceptance[] {
  const grouped = new Map<number, Row[]>();
  for (const row of rawRows) {
    const number = Number(row.acceptanceNumber);
    const list = grouped.get(number) ?? [];
    list.push(row);
    grouped.set(number, list);
  }
  const accs: Acceptance[] = [];
  for (const [number, group] of grouped) {
    const use = profileRows(group);
    const segs = segmentsFromRows(use);
    if (!segs.length) continue;
    accs.push({
      id: number,
      time: parseTime(String(use[0].acceptanceTime)),
      so: isSo(use[0].soFlag),
      segs,
      start: Math.min(...segs.map((seg) => seg.start)),
      end: Math.max(...segs.map((seg) => seg.end)),
    });
  }
  accs.sort((a, b) => a.time - b.time || a.id - b.id);
  return accs;
}

function operativeLevel(
  accs: Acceptance[],
  index: number,
  moment: number,
  pnSegs: Segment[],
): number {
  let chosen: number | null = null;
  for (const earlier of accs.slice(0, index)) {
    if (earlier.start <= moment && moment <= earlier.end) {
      const level = levelAt(earlier.segs, moment);
      if (level !== null) chosen = level;
    }
  }
  if (chosen === null) {
    const fpn = levelAt(pnSegs, moment);
    return fpn === null ? 0 : fpn;
  }
  return chosen;
}

function integrateBidOffer(
  accs: Acceptance[],
  acc: Acceptance,
  pnSegs: Segment[],
  spStart: number,
  spEnd: number,
): [number, number] {
  const left = Math.max(acc.start, spStart);
  const right = Math.min(acc.end, spEnd);
  if (right <= left) return [0, 0];
  const index = accs.indexOf(acc);
  const knots = new Set<number>([left, right]);
  const sources = [acc.segs, pnSegs, ...accs.slice(0, index).map((earlier) => earlier.segs)];
  for (const segs of sources) {
    for (const seg of segs) {
      if (left < seg.start && seg.start < right) knots.add(seg.start);
      if (left < seg.end && seg.end < right) knots.add(seg.end);
    }
  }
  const times = [...knots].sort((a, b) => a - b);
  let bid = 0;
  let offer = 0;
  for (let i = 0; i < times.length - 1; i += 1) {
    const t0 = times[i];
    const t1 = times[i + 1];
    const mid = t0 + (t1 - t0) / 2;
    const newLevel = levelAt(acc.segs, mid);
    if (newLevel === null) continue;
    const delta = newLevel - operativeLevel(accs, index, mid, pnSegs);
    const mwh = (delta * (t1 - t0)) / 3_600_000;
    if (mwh < 0) bid += mwh;
    else offer += mwh;
  }
  return [bid, offer];
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

async function fetchDatasetPeriod(dataset: string, sp: number): Promise<Row[]> {
  const url = `${BASE}/datasets/${dataset}?settlementDate=${DATE}&settlementPeriod=${sp}`;
  return rowsOf(await getJson(url));
}

async function fetchWindow(
  kind: "boalf" | "pn",
  bmUnit: string,
  start: number,
  end: number,
): Promise<Row[]> {
  const params = new URLSearchParams({
    from: isoZ(start),
    to: isoZ(end),
    bmUnit,
  });
  const url =
    kind === "boalf"
      ? `${BASE}/datasets/BOALF?${params}`
      : `${BASE}/balancing/physical?${params}&dataset=PN`;
  return rowsOf(await getJson(url));
}

function dedupeRows(rawRows: Row[], keys: string[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const row of rawRows) {
    const marker = keys.map((key) => String(row[key])).join("|");
    if (seen.has(marker)) continue;
    seen.add(marker);
    out.push(row);
  }
  return out;
}

function fmt(value: number): string {
  return value.toFixed(6);
}

function calendarCheck(): void {
  const july = spBounds("2026-07-01", 1)[0];
  const november = spBounds("2026-11-18", 1)[0];
  const expectJuly = Date.parse("2026-06-30T23:00:00Z");
  const expectNov = Date.parse("2026-11-18T00:00:00Z");
  if (july !== expectJuly || november !== expectNov) {
    throw new Error(`calendar check failed july=${july} november=${november}`);
  }
  console.log(`calendar_check july_sp1_start ${isoZ(july)}`);
  console.log(`calendar_check november_sp1_start ${isoZ(november)}`);
  if (!dayLengthOk(DATE)) {
    throw new Error(
      `${DATE} is a clock-change settlement day. This spike does not handle 46 or 50 periods.`,
    );
  }
}

async function loadProxyUnits(): Promise<{
  units: ProxyUnit[];
  unmatched: number;
  idCount: number;
}> {
  const reference = rowsOf(await getJson(`${BASE}/reference/bmunits/all`));
  const byNg = new Map<string, Row>();
  const byEx = new Map<string, Row>();
  for (const unit of reference) {
    const ng = unit.nationalGridBmUnit;
    const ex = unit.elexonBmUnit;
    if (typeof ng === "string" && !byNg.has(ng)) byNg.set(ng, unit);
    if (typeof ex === "string" && !byEx.has(ex)) byEx.set(ex, unit);
  }
  const jobs: Array<[string, number]> = [];
  for (const dataset of ["MDO", "MDB"]) {
    for (let sp = 1; sp <= 48; sp += 1) jobs.push([dataset, sp]);
  }
  const found = new Map<string, Set<string>>();
  const periodRows = await mapPool(jobs, 6, async ([dataset, sp]) => ({
    dataset,
    rows: await fetchDatasetPeriod(dataset, sp),
  }));
  for (const period of periodRows) {
    for (const row of period.rows) {
      const ng = String(row.nationalGridBmUnit);
      const tags = found.get(ng) ?? new Set<string>();
      tags.add(`${period.dataset}|${String(row.bmUnit)}`);
      found.set(ng, tags);
    }
  }
  const units: ProxyUnit[] = [];
  let unmatched = 0;
  for (const [ng, tags] of found) {
    let unit = byNg.get(ng);
    if (!unit) {
      for (const tag of tags) {
        unit = byEx.get(tag.split("|")[1]);
        if (unit) break;
      }
    }
    if (!unit || (unit.gspGroupId !== "_N" && unit.gspGroupId !== "_P")) {
      if (!unit) unmatched += 1;
      continue;
    }
    const datasets = [...new Set([...tags].map((tag) => tag.split("|")[0]))].sort();
    units.push({
      elexon: String(unit.elexonBmUnit),
      ng: String(unit.nationalGridBmUnit),
      gsp: String(unit.gspGroupId),
      gspName: String(unit.gspGroupName ?? ""),
      fuel: unit.fuelType == null ? null : String(unit.fuelType),
      name: String(unit.bmUnitName ?? ""),
      party: String(unit.leadPartyName ?? ""),
      bmUnitType: unit.bmUnitType == null ? null : String(unit.bmUnitType),
      datasets,
    });
  }
  units.sort((a, b) => a.elexon.localeCompare(b.elexon));
  return { units, unmatched, idCount: found.size };
}

function windowsFor(date: string): Array<[number, number]> {
  const start = settlementMidnight(date);
  return [
    [start - 12 * 3_600_000, start],
    [start, start + 24 * 3_600_000],
    [start + 24 * 3_600_000, start + 36 * 3_600_000],
  ];
}

async function loadUnit(unit: ProxyUnit) {
  const mainStart = settlementMidnight(DATE);
  const mainRows = await fetchWindow("boalf", unit.elexon, mainStart, mainStart + 24 * 3_600_000);
  const soIds = new Set(
    mainRows.filter((row) => isSo(row.soFlag)).map((row) => Number(row.acceptanceNumber)),
  );
  let detail: { bo: Row[]; pn: Row[]; boav: Row[] } | null = null;
  if (soIds.size) {
    let boRows: Row[] = [];
    let pnRows: Row[] = [];
    for (const [start, end] of windowsFor(DATE)) {
      boRows = boRows.concat(await fetchWindow("boalf", unit.elexon, start, end));
      pnRows = pnRows.concat(await fetchWindow("pn", unit.elexon, start, end));
    }
    boRows = dedupeRows(boRows, [
      "acceptanceNumber",
      "timeFrom",
      "timeTo",
      "levelFrom",
      "levelTo",
      "amendmentFlag",
    ]);
    pnRows = dedupeRows(pnRows, [
      "timeFrom",
      "timeTo",
      "levelFrom",
      "levelTo",
      "settlementPeriod",
      "settlementDate",
    ]);
    const boav = rowsOf(
      await getJson(
        `${BASE}/balancing/settlement/acceptance/volumes/all/bid/${DATE}?bmUnit=${encodeURIComponent(unit.elexon)}`,
      ),
    );
    detail = { bo: boRows, pn: pnRows, boav };
  }
  return { ...unit, mainRows: mainRows.length, soAcceptances: soIds.size, detail };
}

function compareUnit(loaded: Awaited<ReturnType<typeof loadUnit>>) {
  const detail = loaded.detail;
  if (!detail) throw new Error("compare called without detail");
  const pnSegs = segmentsFromRows(detail.pn.filter((row) => row.dataset === "PN"));
  const accs = buildAcceptances(detail.bo);
  const byId = new Map(accs.map((acc) => [acc.id, acc]));
  let matched = 0;
  let missing = 0;
  let worst = 0;
  const lines: string[] = [];
  const boav = [...detail.boav].sort(
    (a, b) =>
      Number(a.settlementPeriod) - Number(b.settlementPeriod) ||
      Number(a.acceptanceId) - Number(b.acceptanceId),
  );
  for (const row of boav) {
    const acc = byId.get(Number(row.acceptanceId));
    const published = Number(row.totalVolumeAccepted);
    if (!acc) {
      missing += 1;
      lines.push(
        `  sp ${row.settlementPeriod} acceptance ${row.acceptanceId} published_mwh ${fmt(published)} computed_mwh missing`,
      );
      continue;
    }
    const [spStart, spEnd] = spBounds(String(row.settlementDate), Number(row.settlementPeriod));
    const [bid] = integrateBidOffer(accs, acc, pnSegs, spStart, spEnd);
    worst = Math.max(worst, Math.abs(bid - published));
    matched += 1;
    lines.push(
      `  sp ${row.settlementPeriod} acceptance ${row.acceptanceId} published_mwh ${fmt(published)} computed_mwh ${fmt(bid)}`,
    );
  }
  const pnKeys = detail.pn.length ? Object.keys(detail.pn[0]).sort() : [];
  return { matched, missing, worst, lines, accs, pnKeys, boav: detail.boav };
}

function repeatedPairs(accs: Acceptance[], boav: Row[]) {
  const negativeIds = new Set<number>();
  for (const row of boav) {
    if (Number(row.totalVolumeAccepted) < 0) negativeIds.add(Number(row.acceptanceId));
  }
  const bids = accs
    .filter((acc) => acc.so && negativeIds.has(acc.id))
    .sort((a, b) => a.time - b.time || a.id - b.id);
  const pairs: Record<number, number> = { 3: 0, 6: 0, 12: 0 };
  const withLater: Record<number, number> = { 3: 0, 6: 0, 12: 0 };
  for (let i = 0; i < bids.length; i += 1) {
    const laterHours: number[] = [];
    for (const later of bids.slice(i + 1)) {
      const hours = (later.time - bids[i].time) / 3_600_000;
      if (hours <= 0) continue;
      laterHours.push(hours);
      for (const window of [3, 6, 12]) {
        if (hours <= window) pairs[window] += 1;
      }
    }
    for (const window of [3, 6, 12]) {
      if (laterHours.some((hours) => hours <= window)) withLater[window] += 1;
    }
  }
  return { systemBids: bids.length, pairs, withLater };
}

function priceIndex(priceRows: Row[]) {
  const index = new Map<string, Row>();
  for (const row of priceRows) {
    index.set(`${row.bmUnit}|${row.acceptanceNumber}|${row.bidOfferPairId}`, row);
  }
  return index;
}

async function costExample(
  loaded: Awaited<ReturnType<typeof loadUnit>>,
  compared: ReturnType<typeof compareUnit>,
): Promise<void> {
  const detail = loaded.detail;
  if (!detail) return;
  const soIds = new Set(compared.accs.filter((acc) => acc.so).map((acc) => acc.id));
  const candidates = detail.boav.filter(
    (row) => soIds.has(Number(row.acceptanceId)) && Number(row.totalVolumeAccepted) < 0,
  );
  if (!candidates.length) {
    console.log("cost_example none");
    return;
  }
  const chosen = [...candidates].sort((a, b) => {
    const aTime = compared.accs.find((item) => item.id === Number(a.acceptanceId))?.time ?? 0;
    const bTime = compared.accs.find((item) => item.id === Number(b.acceptanceId))?.time ?? 0;
    return (
      aTime - bTime ||
      Number(a.acceptanceId) - Number(b.acceptanceId) ||
      Math.abs(Number(b.totalVolumeAccepted)) - Math.abs(Number(a.totalVolumeAccepted))
    );
  })[0];
  const signed = Number(chosen.totalVolumeAccepted);
  const sp = Number(chosen.settlementPeriod);
  const prices = rowsOf(
    await getJson(`${BASE}/balancing/settlement/acceptances/all/${DATE}/${sp}`),
  );
  const offers = rowsOf(
    await getJson(
      `${BASE}/balancing/settlement/acceptance/volumes/all/offer/${DATE}/${sp}`,
    ),
  );
  const index = priceIndex(prices);
  let bidComponent = 0;
  const pairBits: string[] = [];
  const pairs = (chosen.pairVolumes ?? {}) as Record<string, number | null>;
  for (let n = 1; n <= 6; n += 1) {
    const raw = pairs[`negative${n}`];
    if (raw == null || Number(raw) === 0) continue;
    const volume = Number(raw);
    const priceRow = index.get(`${chosen.bmUnit}|${chosen.acceptanceId}|${-n}`);
    if (!priceRow || priceRow.bidPrice == null) {
      pairBits.push(`pair -${n} mwh ${fmt(volume)} bid_price missing`);
      continue;
    }
    const price = Number(priceRow.bidPrice);
    bidComponent += price * volume;
    pairBits.push(`pair -${n} mwh ${fmt(volume)} bid_price ${fmt(price)}`);
  }
  let num = 0;
  let den = 0;
  let unpriced = 0;
  for (const row of offers) {
    const offerPairs = (row.pairVolumes ?? {}) as Record<string, number | null>;
    for (let n = 1; n <= 6; n += 1) {
      const raw = offerPairs[`positive${n}`];
      if (raw == null || Number(raw) === 0) continue;
      const volume = Number(raw);
      const priceRow = index.get(`${row.bmUnit}|${row.acceptanceId}|${n}`);
      if (!priceRow || priceRow.offerPrice == null) {
        unpriced += 1;
        continue;
      }
      num += Number(priceRow.offerPrice) * volume;
      den += volume;
    }
  }
  console.log("cost_example");
  console.log("label estimate of one system bid, not an attributed loop cost");
  console.log(`bm_unit ${chosen.bmUnit}`);
  console.log(`acceptance ${chosen.acceptanceId}`);
  console.log(`settlement_period ${sp}`);
  console.log(`signed_bid_mwh ${fmt(signed)}`);
  for (const bit of pairBits) console.log(`  ${bit}`);
  if (den === 0) {
    console.log("offer_wavg_gbp_per_mwh missing");
    console.log(`unpriced_offer_pairs ${unpriced}`);
    return;
  }
  const wavg = num / den;
  const replacement = wavg * -signed;
  const net = bidComponent + replacement;
  console.log(`bid_component_gbp ${fmt(bidComponent)}`);
  console.log(`offer_wavg_gbp_per_mwh ${fmt(wavg)}`);
  console.log(`offer_mwh_in_sp ${fmt(den)}`);
  console.log(`unpriced_offer_pairs ${unpriced}`);
  console.log(`replacement_gbp ${fmt(replacement)}`);
  console.log(`net_gbp ${fmt(net)}`);
  console.log(
    "convention bid_component = sum(bid_price * signed_pair_mwh); replacement = offer_wavg * (-signed_bid_mwh); net = bid_component + replacement",
  );
  console.log(
    "sign_note the Nov 2026 NESO appendix says the bid term is typically a negative cost that offsets replacement. This line follows that reading. It is an estimate.",
  );
}

async function nesoSection(): Promise<void> {
  const packageShow = (await getJson(
    "https://api.neso.energy/api/3/action/package_show?id=day-ahead-constraint-flows-and-limits",
  )) as {
    result: { resources: Array<{ datastore_active?: boolean; id: string }> };
  };
  const resource = packageShow.result.resources.find((item) => item.datastore_active);
  if (!resource) throw new Error("NESO dataset has no datastore");
  const meta = (await getJson(
    `https://api.neso.energy/api/3/action/datastore_search?resource_id=${resource.id}&limit=0`,
  )) as { result: { fields: Array<{ id: string }> } };
  const fields = meta.result.fields.map((field) => field.id).filter((id) => id !== "_id");
  const dateField = fields.find((name) => name.includes("Date"));
  const groupField = fields.find((name) => name.includes("Constraint"));
  if (!dateField || !groupField) throw new Error("NESO fields missing");
  const sql =
    `SELECT "${groupField}" AS grp, COUNT(*) AS n FROM "${resource.id}" ` +
    `WHERE "${dateField}" >= '${DATE}T00:00:00' AND "${dateField}" < '${shiftDate(DATE, 1)}T00:00:00' ` +
    `GROUP BY "${groupField}" ORDER BY "${groupField}"`;
  const query = (await getJson(
    `https://api.neso.energy/api/3/action/datastore_search_sql?${new URLSearchParams({ sql })}`,
  )) as { result: { records: Array<{ grp: string; n: number }> } };
  const records = query.result.records;
  const total = records.reduce((sum, row) => sum + Number(row.n), 0);
  console.log("neso_dataset day-ahead-constraint-flows-and-limits");
  console.log(`neso_fields ${fields.join(", ")}`);
  console.log(`neso_rows_on_date ${total}`);
  console.log(`neso_constraint_groups ${records.map((row) => row.grp).join(" ")}`);
  console.log("neso_bm_unit_column no");
  const ancillary = (await getJson(
    "https://api.neso.energy/api/3/action/package_show?id=dynamic-containment-data",
  )) as {
    result: { resources: Array<{ format?: string; name?: string }> };
  };
  const names = ancillary.result.resources.map((item) => `${item.format}:${item.name}`);
  console.log("ancillary_package dynamic-containment-data");
  console.log(`ancillary_resources ${names.join(" | ")}`);
  console.log(
    "ancillary_gap auction results are not a unit-level negative DC Low, DM Low, DR Low, or Negative Quick Reserve position for the next 3h. That flag is unknown.",
  );
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log("spike bess-constraint-replay");
  console.log("language typescript");
  console.log("throwaway yes");
  console.log("command node --experimental-strip-types scratch/spike/ts/spike.ts");
  console.log(`settlement_date ${DATE}`);
  console.log(`started_utc ${isoZ(Date.now())}`);
  console.log(
    "proxy units that submit MDO or MDB on this date, sit in GSP _N or _P, and have a soFlag acceptance. This is a proxy, not an official constraint map.",
  );
  calendarCheck();
  const { units, unmatched, idCount } = await loadProxyUnits();
  console.log(`mdo_or_mdb_bm_units ${idCount}`);
  console.log(`mdo_mdb_ids_missing_from_reference ${unmatched}`);
  console.log(`proxy_candidates_scottish_mdo_or_mdb ${units.length}`);
  const loaded = await mapPool(units, 4, loadUnit);
  loaded.sort((a, b) => a.elexon.localeCompare(b.elexon));
  const detailed = loaded.filter((item) => item.soAcceptances > 0);
  console.log(`proxy_units_with_soflag ${detailed.length}`);
  for (const item of loaded) {
    const fuel = item.fuel ?? "null";
    const bmType = item.bmUnitType ?? "null";
    console.log(
      `candidate ${item.elexon} ng ${item.ng} gsp ${item.gsp} fuel ${fuel} type ${bmType} datasets ${item.datasets.join("+")} so_acceptances ${item.soAcceptances} name ${item.name} party ${item.party}`,
    );
  }
  let failed = false;
  for (const item of detailed) {
    const compared = compareUnit(item);
    console.log(`unit ${item.elexon} ng ${item.ng} gsp ${item.gsp}`);
    console.log(`boav_bid_rows ${compared.matched + compared.missing}`);
    console.log(`matched ${compared.matched}`);
    console.log(`missing_profile ${compared.missing}`);
    console.log(`worst_abs_mwh ${compared.worst.toExponential(3)}`);
    console.log(`pn_keys ${compared.pnKeys.join(" ")}`);
    for (const line of compared.lines) console.log(line);
    const { systemBids, pairs, withLater } = repeatedPairs(compared.accs, item.detail?.boav ?? []);
    console.log("loops_confirmed 0");
    console.log(
      "loops_reason public PN rows have no submission timestamp, so a later positive FPN change cannot be timed against the system bid",
    );
    console.log(`system_bid_acceptances ${systemBids}`);
    console.log(`system_bids_with_later_bid_within_3h ${withLater[3]}`);
    console.log(`system_bids_with_later_bid_within_6h ${withLater[6]}`);
    console.log(`system_bids_with_later_bid_within_12h ${withLater[12]}`);
    console.log(`repeated_bid_pairs_within_3h ${pairs[3]}`);
    console.log(`repeated_bid_pairs_within_6h ${pairs[6]}`);
    console.log(`repeated_bid_pairs_within_12h ${pairs[12]}`);
    console.log(
      "repeated_bid_pairs_label ordered pairs of soFlag acceptances with negative published bid volume. Not confirmed loops.",
    );
    await costExample(item, compared);
    if (compared.matched === 0 || compared.missing || compared.worst >= TOL_MWH) failed = true;
  }
  const hist = rowsOf(
    await getJson(`${BASE}/datasets/MDO?settlementDate=2025-12-03&settlementPeriod=20`),
  );
  console.log(`mdo_rows_2025_12_03_sp20 ${hist.length}`);
  await nesoSection();
  const elapsed = (Date.now() - started) / 1000;
  console.log(`elapsed_s ${elapsed.toFixed(1)}`);
  console.log(`http_requests ${REQUESTS}`);
  console.log("elapsed_note elapsed_s is mostly HTTP round trips. It is not a language benchmark.");
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
