# Throwaway spike

These scripts answer one question. Can a small TypeScript program and a small Python program both reproduce Elexon's published bid volumes for one settlement date, and what does that imply for the backend.

They are not the product. Delete them when `pr-volume` has its own fixture and live check.

## Run

From the repo root, with network access.

```bash
python3 scratch/spike/python/spike.py
node --experimental-strip-types scratch/spike/ts/spike.ts
```

The default settlement date is 2026-11-18. Pass another `YYYY-MM-DD` as the first argument. Clock-change days stop before any HTTP call.

## Captured output

`output/python.txt` and `output/typescript.txt` are the stdout of those commands on 2026-11-26. Both exited 0. Ignoring the language name, the command line, the start time, and the elapsed time, the two files match line for line.

The volume lines are the reproducibility check. `published_mwh` is Elexon BOAV `totalVolumeAccepted`. `computed_mwh` is the script. On this run the worst absolute gap was 3.553e-15 MWh across 121 rows.

`loops_confirmed 0` is the loop result. The public PN payload has no submission timestamp, so the scripts do not claim a loop. The repeated-bid counts are pairs of system bids, and the files say so.

Cost lines are estimates for one system bid. They are not an attributed loop cost.
