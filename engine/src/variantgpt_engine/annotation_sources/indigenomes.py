"""IndiGenomes (IGIB) allele-frequency lookup.

Cohort: 1,029 unrelated Indian whole genomes from the IGIB IndiGen project.
Source: https://clingen.igib.res.in/indigen/

The full IndiGen VCF (~137 MB compressed, ~55M variants) is pre-processed
into a compact SQLite DB by tracks/build_indigen_freqs.py and hosted on R2
at the key advertised in INDIGEN_R2_KEY below.

At engine startup we download the DB once to /tmp and reuse it for the
machine's lifetime. Per-variant lookups are sub-millisecond (B-tree index
on (chrom, pos, ref, alt)).

If the DB isn't present (or the download fails), IndiGen lookups return None
gracefully — the pipeline degrades to gnomAD + ClinVar only.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Iterable, Optional

import httpx

from ..models import PopulationAF

log = logging.getLogger(__name__)

# Local cache path (inside the Fly machine's /tmp).
LOCAL_DB = Path(os.environ.get("INDIGEN_DB_PATH", "/tmp/variantgpt/indigen.sqlite"))
# R2 key — the Worker mints a signed GET URL the engine fetches at startup.
INDIGEN_R2_KEY_DEFAULT = "tracks/indigenomes/v1/indigen.sqlite"


class IndiGenDB:
    """Wraps the SQLite freq DB with a lookup interface. Thread-safe for read."""

    def __init__(self, db_path: Path):
        self.path = db_path
        # check_same_thread=False — we want the same connection across
        # asyncio tasks; sqlite3 is fine with concurrent reads.
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.execute("PRAGMA query_only = ON")
        self.conn.row_factory = sqlite3.Row

    def lookup(self, chrom: str, pos: int, ref: str, alt: str) -> Optional[dict]:
        """Return {ac, an, af, n_hom} or None if the variant isn't in IndiGen."""
        c = self._normalize_chrom(chrom)
        row = self.conn.execute(
            "SELECT ac, an, af, n_hom FROM freq "
            "WHERE chrom = ? AND pos = ? AND ref = ? AND alt = ? LIMIT 1",
            (c, pos, ref, alt),
        ).fetchone()
        if row is None:
            return None
        return {"ac": row["ac"], "an": row["an"], "af": row["af"], "n_hom": row["n_hom"]}

    def lookup_many(self, keys: Iterable[tuple[str, int, str, str]]) -> dict[tuple, dict]:
        """Bulk lookup. Returns a dict keyed by (chrom, pos, ref, alt)."""
        out: dict[tuple, dict] = {}
        for key in keys:
            res = self.lookup(*key)
            if res:
                out[key] = res
        return out

    @staticmethod
    def _normalize_chrom(chrom: str) -> str:
        bare = chrom.removeprefix("chr").removeprefix("Chr")
        if bare in ("M", "MT"):
            bare = "M"
        return f"chr{bare}"

    def close(self) -> None:
        self.conn.close()


_DB_SINGLETON: Optional[IndiGenDB] = None


def get_db() -> Optional[IndiGenDB]:
    """Return the loaded IndiGen DB if it's available locally, else None."""
    global _DB_SINGLETON
    if _DB_SINGLETON is not None:
        return _DB_SINGLETON
    if LOCAL_DB.exists() and LOCAL_DB.stat().st_size > 0:
        _DB_SINGLETON = IndiGenDB(LOCAL_DB)
        log.info("IndiGen DB loaded from %s (%.1f MB)",
                 LOCAL_DB, LOCAL_DB.stat().st_size / 1024 / 1024)
        return _DB_SINGLETON
    return None


async def ensure_db_downloaded(signed_url: Optional[str]) -> bool:
    """Download the IndiGen SQLite DB from R2 if not present locally.

    Returns True if the DB is ready, False if not (e.g. signed_url missing or
    download failed). Callers should treat False as "IndiGen lookups disabled
    for this run" and continue.
    """
    if LOCAL_DB.exists() and LOCAL_DB.stat().st_size > 0:
        return True
    if not signed_url:
        log.warning("IndiGen R2 URL not provided; skipping IndiGen lookups")
        return False

    LOCAL_DB.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOCAL_DB.with_suffix(".tmp")
    try:
        log.info("downloading IndiGen DB from %s", signed_url)
        t = time.time()
        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream("GET", signed_url) as resp:
                resp.raise_for_status()
                with open(tmp, "wb") as out:
                    async for chunk in resp.aiter_bytes():
                        out.write(chunk)
        tmp.replace(LOCAL_DB)
        log.info(
            "IndiGen DB downloaded in %ds (%.1f MB)",
            int(time.time() - t), LOCAL_DB.stat().st_size / 1024 / 1024,
        )
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("IndiGen DB download failed: %s", e)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        return False


def populations_for(chrom: str, pos: int, ref: str, alt: str) -> list[PopulationAF]:
    """Convenience: return PopulationAF row(s) for the engine pipeline.

    Returns empty list if IndiGen DB isn't loaded or the variant isn't found.
    """
    db = get_db()
    if db is None:
        return []
    rec = db.lookup(chrom, pos, ref, alt)
    if rec is None:
        return []
    return [PopulationAF(
        source="indigenomes",
        ac=rec.get("ac"),
        an=rec.get("an"),
        af=rec.get("af"),
        n_hom=rec.get("n_hom"),
    )]
