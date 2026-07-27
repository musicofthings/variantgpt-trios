import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** Public onboarding page for partner sites standing up their own VariantGPT
 *  instance. Rendered OUTSIDE <AuthGate> (see App.tsx) — no sign-in required
 *  to read it. Not a general-public marketing page: the engine is licensed
 *  "Proprietary" (engine/pyproject.toml), so this is a direct technical doc
 *  for known/authorized sites, not a sign-up funnel. */
export function Landing() {
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 32px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 20 }}>
          VariantGPT
        </div>
        <nav style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 13 }}>
          <a href="#install">Install</a>
          <a href="#usage">Usage</a>
          <a href="https://github.com/musicofthings/variantgpt-trios">Repository</a>
          <Link to="/" className="pill" style={{ textDecoration: "none" }}>
            Open app →
          </Link>
        </nav>
      </header>

      <main style={{ maxWidth: 880, margin: "0 auto", padding: "48px 32px 96px" }}>
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section style={{ marginBottom: 56 }}>
          <span className="pill" style={{ marginBottom: 16, display: "inline-flex" }}>
            Research use only · non-diagnostic
          </span>
          <h1 style={{ fontSize: 40, marginTop: 16, marginBottom: 16 }}>
            South-Asian-aware clinical variant interpretation
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: "var(--ink-soft)", maxWidth: 640 }}>
            VariantGPT runs ACMG/AMP classification for trio, duo, and singleton germline
            cases, reclassifies allele frequency against Indian-cohort databases, matches
            HPO phenotypes, drafts per-variant clinical synopses, and produces a print-ready
            report — with a built-in three-layer validation suite.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
            <a href="#install" className="pill" style={{ textDecoration: "none", padding: "8px 16px" }}>
              Deployment guide
            </a>
            <a href="#usage" className="pill" style={{ textDecoration: "none", padding: "8px 16px" }}>
              How it's used
            </a>
          </div>
        </section>

        {/* ── What it does ────────────────────────────────────────────── */}
        <Section title="What it does">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 16,
            }}
          >
            <Feature
              title="ACMG/AMP classification"
              body="Tavtigian point-based tier engine with a full fired-criterion evidence ledger per variant."
            />
            <Feature
              title="South-Asian AF reclassification"
              body="Proposals against IndiGenomes, GenomeAsia, and GenomeIndia — deliberately not gnomAD-SAS. Runs bidirectionally: pulls inflated calls down as well as VUS up. Never auto-commits; every tier change needs a recorded curator decision."
            />
            <Feature
              title="HPO phenotype matching"
              body="Case-level phenotype overlap folds into variant prioritization alongside the ACMG tier."
            />
            <Feature
              title="AI-drafted synopses"
              body="Per-variant clinical narrative from a structured prompt (identity / fired criteria / predictors / phenotype overlap) — the model can't invent AFs or criteria. Bring your own API key (see Bring your own key)."
            />
            <Feature
              title="Print-ready report"
              body="Every signed report carries the research-use / non-diagnostic disclaimer."
            />
            <Feature
              title="Three-layer validation"
              body="ClinVar concordance audit, Franklin cross-platform diff, and a reproducible GIAB benchmark (P/R/F1, Cohen's κ)."
            />
          </div>
        </Section>

        {/* ── Architecture ─────────────────────────────────────────────── */}
        <Section title="Architecture">
          <p style={{ color: "var(--ink-soft)", marginBottom: 16 }}>
            Three independently deployed tiers. Data flows edge → off-edge and back via a
            signed webhook.
          </p>
          <div className="card mono" style={{ fontSize: 13, lineHeight: 2, overflowX: "auto" }}>
            <div><strong>web</strong> — React SPA (Vite) → Cloudflare Pages</div>
            <div style={{ paddingLeft: 16 }}>↓</div>
            <div><strong>api</strong> — Hono Worker, /api/* → Cloudflare Workers</div>
            <div style={{ paddingLeft: 16, color: "var(--ink-soft)" }}>
              ├─ D1 — cases, members, jobs, uploads
              <br />
              └─ R2 — VCFs, case.json, reports, caches
            </div>
            <div style={{ paddingLeft: 16 }}>↓ signed job / webhook</div>
            <div>
              <strong>engine</strong> — Python genomics pipeline → <em>your compute</em> (see
              Install)
            </div>
          </div>
        </Section>

        {/* ── BYOK ──────────────────────────────────────────────────────── */}
        <Section title="Bring your own key">
          <p style={{ lineHeight: 1.7 }}>
            AI features (variant synopsis, HPO phrase extraction) call Anthropic directly
            from <strong>your own</strong> Worker deployment, using <strong>your own</strong>{" "}
            <code>ANTHROPIC_API_KEY</code> (or <code>OPENROUTER_API_KEY</code>), set with{" "}
            <code>wrangler secret put</code> in your own Cloudflare account. Nothing is
            hardcoded and nothing routes through the maintainer's account — every site
            bills only for its own usage. Cloudflare AI Gateway is optional and, if used,
            points at your own gateway account too.
          </p>
          <p style={{ lineHeight: 1.7, color: "var(--ink-soft)" }}>
            Skip this step and AI synopsis simply returns "not configured" — every other
            pipeline stage (classification, reclassification, HPO matching, report) runs
            independently of it.
          </p>
        </Section>

        {/* ── Install ───────────────────────────────────────────────────── */}
        <Section id="install" title="Install">
          <h3 style={{ marginBottom: 8 }}>Quick local trial — zero cloud, zero cost</h3>
          <p style={{ color: "var(--ink-soft)", marginBottom: 12 }}>
            Evaluates the classification pipeline itself on your own machine. No Cloudflare
            account, no signup, no AI synopsis (this path has no AI route wired), no
            persistent storage.
          </p>
          <CodeBlock>
{`cd engine
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\\Scripts\\activate
pip install -e .[dev]

cd ../app/web
npm install
npm run dev                    # → http://localhost:5173`}
          </CodeBlock>
          <p style={{ color: "var(--ink-soft)", marginTop: 12 }}>
            The dev server's API middleware runs the real Python engine directly on your
            machine for each case — no Worker, no Fly.io, nothing deployed anywhere.
          </p>

          <h3 style={{ marginTop: 32, marginBottom: 8 }}>Self-hosted — your own Cloudflare account</h3>
          <p style={{ color: "var(--ink-soft)", marginBottom: 12 }}>
            Pages + Worker + D1 + R2, all on Cloudflare's free tier. For the engine tier,{" "}
            <strong>run it on compute you already have</strong> — a workstation or an
            on-prem server — instead of Fly.io. Fly's free allowance
            (<code>shared-cpu-1x</code>, small RAM) doesn't cover this engine's footprint
            (<code>shared-cpu-2x / 4GB</code>, peak RAM ~2–3GB), so Fly requires a paid plan
            for this workload; a machine you already own is free and usually has more
            headroom. Fly.io remains supported for sites that want managed scale-to-zero
            hosting instead — see <code>infra/DEPLOY.md</code>.
          </p>
          <CodeBlock>
{`# On the machine that will host the engine:
cd tracks
python container_server.py           # Starlette HTTP server on :8080

# Expose it publicly (any HTTPS URL works — Cloudflare Tunnel shown):
cloudflared tunnel --url http://localhost:8080

# Point the Worker at the tunnel URL (app/api/wrangler.toml):
ENGINE_BASE_URL = "https://<your-tunnel>.trycloudflare.com"`}
          </CodeBlock>
          <p style={{ color: "var(--ink-soft)", marginTop: 12 }}>
            The rest of the setup — D1 migrations, R2 API token, Worker secrets, Pages
            deploy — is unchanged from <code>infra/DEPLOY.md</code>; only the engine
            hosting step differs.
          </p>
        </Section>

        {/* ── Usage ─────────────────────────────────────────────────────── */}
        <Section id="usage" title="Usage">
          <ol style={{ lineHeight: 2, paddingLeft: 20 }}>
            <li>
              <strong>New case</strong> — pick a pipeline: singleton, duo, or trio. All
              three share the same engine and differ only in how segregation and de-novo
              evidence are interpreted.
            </li>
            <li>
              <strong>Upload</strong> — VCFs (or BAM/CRAM, if a reference is configured)
              per family member.
            </li>
            <li>
              <strong>Run</strong> — the engine classifies every variant and surfaces
              South-Asian reclassification proposals where applicable.
            </li>
            <li>
              <strong>Workbench</strong> — review the tier, the fired-criterion evidence
              ledger, and HPO overlap for each variant. Reclassification proposals stay{" "}
              <code>pending</code> until a curator records a decision — they never
              auto-commit.
            </li>
            <li>
              <strong>AI synopsis</strong> — optional, requires your own API key (see
              Bring your own key above).
            </li>
            <li>
              <strong>Report</strong> — print-ready, always carries the research-use /
              non-diagnostic disclaimer.
            </li>
          </ol>
        </Section>

        <footer
          style={{
            marginTop: 64,
            paddingTop: 24,
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            fontSize: 12,
            color: "var(--ink-soft)",
          }}
        >
          <span>VariantGPT — proprietary, for authorized sites only. Research use only, non-diagnostic.</span>
          <a href="https://github.com/musicofthings/variantgpt-trios">github.com/musicofthings/variantgpt-trios</a>
        </footer>
      </main>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} style={{ marginBottom: 56, scrollMarginTop: 24 }}>
      <h2 style={{ marginBottom: 20, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginBottom: 8, fontSize: 15 }}>{title}</h3>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-soft)", margin: 0 }}>{body}</p>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      className="mono"
      style={{
        background: "var(--ink)",
        color: "#DCE6E3",
        fontSize: 12,
        lineHeight: 1.6,
        padding: "14px 16px",
        borderRadius: "var(--radius-control)",
        overflowX: "auto",
        margin: 0,
      }}
    >
      {children}
    </pre>
  );
}
