"""Print a human-readable per-seed summary for one environment's result folder.

Used by scripts/sweep.slurm and scripts/sweep.pbs to build the body of the
detailed job-completion email (and the SUMMARY_<jobid>.txt saved alongside the
results). Reads only the cheap top-level fields of each seed_*.json.

Usage:
    python3 scripts/_job_summary.py <results_dir> key=val key=val ...
        e.g. env=map_500_d05_predation job=998459 config=maps/... \
             seeds="1 2 3 4 5" max_ticks=4000000 elapsed_s=1234 failed=0
"""
import sys
import os
import json
import glob

rdir = sys.argv[1] if len(sys.argv) > 1 else "."
meta = dict(kv.split("=", 1) for kv in sys.argv[2:] if "=" in kv)

L = ["LifeEngine sweep — job completion summary", ""]
for k in ("env", "job", "config", "seeds", "max_ticks", "elapsed_s", "failed"):
    if k in meta:
        L.append(f"  {k:<10} {meta[k]}")
L.append("")

hdr = (f"{'seed':>4} {'outcome':>9} {'final_pop':>9} {'species':>7} "
       f"{'ext_tick':>11} {'t/s':>6} {'ticks':>11} {'rss_MB':>7}")
L.append(hdr)
L.append("-" * len(hdr))

files = sorted(glob.glob(os.path.join(rdir, "seed_*.json")))
if not files:
    L.append("  (no seed result files found in this folder)")
for fp in files:
    try:
        with open(fp) as f:
            d = json.load(f)
    except Exception as e:                       # unreadable / truncated
        L.append(f"  {os.path.basename(fp)}: unreadable ({e})")
        continue
    reached = bool(d.get("reached_max_ticks"))
    L.append(
        f"{str(d.get('seed', '?')):>4} "
        f"{'survived' if reached else 'EXTINCT':>9} "
        f"{d.get('final_population', 0):>9} "
        f"{d.get('final_species', 0):>7} "
        f"{('-' if reached else d.get('extinction_tick', '?')):>11} "
        f"{str(d.get('ticks_per_second', '?')):>6} "
        f"{d.get('total_ticks', 0):>11,} "
        f"{str(d.get('peak_rss_mb') or 0):>7}"
    )

print("\n".join(L))
