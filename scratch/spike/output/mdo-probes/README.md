# MDO probes

These files are the raw Elexon bodies for the 2025 checks. Each `datasets/MDO` body is `{"data":[]}`. The dynamic-parameters body for 2025-12-03 period 20 lists datasets MDO and MDB and has an empty `data` array.

The same `datasets/MDO` call for 2026-11-18 period 32 returned 942 rows and 273410 bytes. That body is not stored here.

| File | URL |
| --- | --- |
| `mdo-2025-12-03-sp20.json` | `/datasets/MDO?settlementDate=2025-12-03&settlementPeriod=20` |
| `mdo-2025-11-12-sp32.json` | `/datasets/MDO?settlementDate=2025-11-12&settlementPeriod=32` |
| `mdo-2025-01-08-sp32.json` | `/datasets/MDO?settlementDate=2025-01-08&settlementPeriod=32` |
| `dyn-2025-12-03-sp20.json` | `/balancing/dynamic/dynamicParameters/all?settlementDate=2025-12-03&settlementPeriod=20&dataset=MDO&dataset=MDB` |

Base URL: `https://data.elexon.co.uk/bmrs/api/v1`.

Three periods are not a scan of calendar 2025.
