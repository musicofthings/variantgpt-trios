# VariantGPT — Frontend Design Specification
## For the design agent · companion to `VariantGPT_PRD_TRD.md`

> Build a **light‑theme**, production‑grade clinical interface. Target deploy: Cloudflare Pages (SPA). This document defines aesthetic direction, design system, screens, components, and interaction patterns. The PRD/TRD defines the API contract and data — design to that contract.

---

## 1. Aesthetic direction
**Concept: "clinical precision, editorial calm."** This is a tool a geneticist signs their name to — it must read as *trustworthy, exact, and quiet*, not as a flashy dashboard. The memorable quality is **the evidence ledger**: dense genomic data made legible and scannable, like a beautifully set scientific journal crossed with a precision instrument readout.

Refined‑minimal, not maximalist. Restraint, precise spacing, and typographic hierarchy carry the design. Light, warm, paper‑like — never stark clinical white, never a dark theme. No generic AI aesthetic: avoid Inter/Roboto/Arial, avoid purple‑on‑white gradients, avoid cookie‑cutter card grids.

---

## 2. Design tokens

### Color (light theme)
Warm, low‑glare base with a single confident primary and a tightly controlled semantic palette. Use CSS variables.
```
--bg:            #FAF8F4   /* warm paper, app background */
--surface:       #FFFFFF   /* cards, panels */
--surface-sunken:#F2EFE8   /* table stripes, wells */
--border:        #E4DFD5   /* hairlines */
--ink:           #1C2826   /* primary text — deep desaturated teal-black */
--ink-soft:      #5A6360   /* secondary text */
--primary:       #0E6E64   /* deep clinical teal — actions, links, focus */
--primary-soft:  #D7EAE6   /* teal tint for selected/active rows */
--accent:        #B4541E   /* warm sienna — used sparingly for emphasis only */
```

### ACMG tier semantics (colorblind‑safe — never color alone)
Each tier carries **color + a fixed letter token + a shape/weight cue**. Do not rely on red/green discrimination.
```
Pathogenic        P    --tier-p:  #B3261E  (solid filled chip, bold)
Likely Pathogenic LP   --tier-lp: #C9662B  (filled chip)
VUS               VUS  --tier-vus:#9A8C66  (outlined chip, neutral ochre)
Likely Benign     LB   --tier-lb: #3A7CA5  (filled chip, blue — not green)
Benign            B    --tier-b:  #2F6E54  (filled chip)
```
Use blue for LB and green for B so the benign end is distinguishable for red‑green colorblind users; pathogenic end uses red→orange. Always render the letter token inside the chip.

**Reclassification highlight:** a distinct **sienna left‑border + subtle tint** on any variant with a pending reclassification proposal, plus a small "Δ" delta badge showing the point shift (e.g., `VUS → LB  Δ −5`).

### Typography
Distinctive, legible, scientific. Pair a **characterful humanist serif for display/headings** with a **clean grotesque for body/UI** and a **mono for all genomic notation**.
```
--font-display: "Fraunces", Georgia, serif;        /* headings, case titles */
--font-body:    "Public Sans", system-ui, sans-serif;
--font-mono:    "JetBrains Mono", ui-monospace, monospace; /* HGVS, coords, AF */
```
Rules: **All genomic strings render in mono** — chromosomal coordinates, HGVS c./p., rsIDs, allele frequencies, gene symbols in tabular context. Numbers in tables are tabular‑figures, right‑aligned. Generous line‑height in the evidence ledger (1.6) for scanability; tight, dense line‑height in data tables.

### Space, radius, elevation
8px spacing base. Radius: 6px controls, 10px cards. Elevation is subtle — hairline borders + one soft shadow (`0 1px 3px rgba(28,40,38,.06)`), never heavy drop shadows. Lots of negative space around the variant detail; controlled density in the variant table.

### Motion
Purposeful and quiet. One orchestrated load reveal per screen (staggered fade/translate, ≤ 250ms, `prefers-reduced-motion` respected). Row hover: gentle tint + border. Drawer slide‑in 200ms ease‑out. The reclassification delta badge gets a single subtle pulse on first appearance, then static. No decorative animation.

---

## 3. App shell & navigation
- **Left rail** (collapsible): Cases, New Case, Tracks/Settings. Wordmark "VariantGPT" in display serif at top; a thin bridge motif as the only ornament.
- **Top bar:** case name (display serif), build badge (GRCh38/37), case status pill, signatory state, primary action (Generate Report).
- Content area is single‑focus per route. Avoid multi‑panel overload except the workbench (table + detail drawer).

---

## 4. Screens

### 4.1 Case dashboard (case list)
Editorial table of cases: name, proband, #findings, VUS count, reclassification count (with Δ badge), status, last updated. Sorting and a quiet search. Empty state: a calm illustration of the bridge motif + "Create your first case."

### 4.2 Case intake (the most form‑heavy screen — make it feel guided, not bureaucratic)
A vertical, sectioned flow (not a wizard with hidden steps — show all sections, anchor‑nav on the side):
1. **Pedigree builder** (see §5.1) — required.
2. **Phenotype (HPO)** — required; autocomplete chips (§5.2).
3. **Clinical history** — required free‑text area with onset age, consanguinity toggle, prior‑testing fields. After entry, show the **LLM‑extracted HPO candidates** as dashed‑outline suggestion chips the curator taps to confirm (confirmed → solid chips join the HPO set). Make the AI‑suggested vs. confirmed distinction visually obvious.
4. **VCF upload** — one drop‑zone per pedigree member, labeled by role; show sample‑name → member mapping with a fix‑up control if names mismatch.
A persistent footer summarizes readiness ("Pedigree ✓ · HPO ✓ · History ✓ · 3/3 VCFs") and enables **Run analysis** only when complete.

### 4.3 Variant workbench (the core)
Two‑region: a **dense variant table** (left/main) + a **detail drawer** (right, opens on row select).
- **Inheritance‑model tabs** across the top, Franklin‑style: `All · De novo · Compound het · Recessive (hom) · Dominant inherited · X‑linked · Reclassified`. The Reclassified tab is visually distinct (sienna) and badged with the count.
- **Filters** (collapsible bar): tier, gene, consequence, population‑AF threshold (a live slider that re‑queries and recomputes reclassification — show a subtle "recomputing" shimmer on affected rows), predictor cutoffs, quality/confidence.
- **Table columns:** priority rank · gene (mono) · HGVS c. / p. (mono, truncated with hover‑full) · consequence · inheritance model chip(s) · gnomAD global AF · **gnomAD SAS AF** · IndiGenomes AF · tier chip · reclassification Δ badge. Right‑align all frequencies (mono, tabular). Default sort: priority score.
- Rows with a pending reclassification carry the sienna left‑border treatment.

### 4.4 Variant detail drawer (the transparency centerpiece)
This is what makes VariantGPT "better than Franklin" — show the *whole reasoning*:
- **Header:** gene + HGVS (mono), MANE transcript, consequence, big tier chip, and (if applicable) the **reclassification card**: `VUS → Likely Benign`, the Δ, and "Awaiting your decision."
- **Evidence ledger:** a clean two‑column ledger of every ACMG criterion *considered* — fired ones in full color with strength (e.g., `PM2  Supporting`), not‑fired ones muted/struck. Each fired criterion expands to show **the exact data point and source** that triggered it. Group by Pathogenic / Benign. This must read like a journal table, not a dump.
- **Population frequency panel:** a small horizontal comparison of AF across gnomAD‑global, gnomAD‑sas, IndiGenomes, GenomeAsia, (GenomeIndia if present) — a minimal bar/lollipop chart with the threshold line marked, so the curator *sees* why a South Asian baseline changed the call.
- **Predictors:** AlphaMissense / REVEL / CADD / SpliceAI as compact gauges with calibrated‑threshold markers.
- **AI synopsis (clearly labeled):** the LLM evidence summary + a "Draft interpretation" the curator can edit; a visible "AI‑drafted — review before signing" marker.
- **Decision controls:** for a pending proposal — **Accept / Reject / Modify** with an optional note. The action is weighty by design (confirm step), and writes to the audit log.

### 4.5 Report view
Print‑grade preview matching the PDF: case + pedigree + HPO summary, prioritized findings with rationale, reclassification decisions table, methods/limitations, version snapshot, signatory block + research‑use disclaimer. Export buttons: PDF / JSON / TSV.

---

## 5. Key custom components

### 5.1 Pedigree builder
Interactive standard pedigree (squares = male, circles = female, filled = affected, diamond/unknown sex). Click to add relations; right‑click/long‑press to set affected status; a consanguinity connector (double line) toggle. Default state pre‑seeds the classic trio (affected proband ▪/● filled below two unaffected parents). Must support adding siblings, second parent‑set, and marking any member missing/no‑sample. Render to standard pedigree notation; persist as PED + graph.

### 5.2 HPO autocomplete chips
Type‑ahead against the HPO release; shows term + ID; Enter to add as a solid chip. LLM‑suggested terms appear as **dashed** chips with a "+" to confirm. Clear visual difference between confirmed (solid, teal‑tinted) and suggested (dashed, neutral).

### 5.3 ACMG tier chip
Fixed component: tier color + letter token + (optional) strength. Always includes the letter for colorblind safety. Variants: filled (definitive tiers), outlined (VUS).

### 5.4 Reclassification delta badge
Compact `from → to  Δ±n` pill in sienna. Tooltip lists the criteria that changed. Appears in table rows, the detail header, and the report.

### 5.5 Evidence ledger row
Criterion token · strength · one‑line trigger summary · source tag · expand chevron. Fired = full color; considered‑but‑not‑fired = muted; benign vs pathogenic grouped and subtly tinted (benign group cool, pathogenic group warm) without screaming.

---

## 6. Accessibility & states
- **Colorblind safety:** every tier and the reclassification state carry a non‑color cue (letter token, Δ glyph, border). Verify against deuteranopia/protanopia.
- **Contrast:** body text ≥ 7:1 on `--bg`; chips meet 4.5:1 with their text.
- **Keyboard:** full table + drawer navigation; the Accept/Reject/Modify decision is keyboard‑operable with a confirm.
- **Loading:** skeleton rows for the table; per‑row shimmer when a live AF re‑query is recomputing; never block the whole screen for one variant's LLM call.
- **Empty/error:** calm, specific copy; if AI assist fails, the deterministic ledger still renders fully ("AI synopsis unavailable").
- **Reduced motion:** honor `prefers-reduced-motion`.

---

## 7. What to get exactly right (priority order)
1. The **evidence ledger** legibility — this is the product.
2. The **population‑frequency comparison** in the detail drawer — it visually justifies every reclassification.
3. **Colorblind‑safe tier + reclassification encoding** — non‑negotiable for clinical trust.
4. The **intake flow** feeling guided, with the AI‑suggested‑vs‑confirmed HPO distinction crystal clear.
5. Quiet, precise **typography and spacing** — mono for all genomic notation, tabular figures, generous ledger leading.

Light theme throughout. Refined, not flashy. Make a geneticist trust it on first glance.
