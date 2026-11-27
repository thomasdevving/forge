import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SiteNav } from "@/components/landing/SiteNav";
import { DOCS, readDoc } from "@/lib/docs";

export const dynamicParams = false;
export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const d = DOCS.find((x) => x.slug === slug);
  return { title: d ? `${d.title} · FORGE docs` : "FORGE docs" };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const md = readDoc(slug);
  if (md == null) notFound();
  const i = DOCS.findIndex((d) => d.slug === slug);
  const prev = DOCS[i - 1], next = DOCS[i + 1];
  const groups = [...new Set(DOCS.map((d) => d.group))];

  return (
    <div className="min-h-dvh bg-bg">
      <SiteNav solid />
      <div className="mx-auto grid max-w-[1280px] gap-10 px-5 pb-24 pt-24 sm:px-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          {groups.map((g) => (
            <div key={g} className="mb-6">
              <div className="cap mb-2 uppercase tracking-[0.18em]">{g}</div>
              <ul className="space-y-0.5 border-l border-line">
                {DOCS.filter((d) => d.group === g).map((d) => (
                  <li key={d.slug}>
                    <Link
                      href={`/docs/${d.slug}`}
                      className={`-ml-px block border-l py-1.5 pl-3 text-[13px] transition-colors ${d.slug === slug ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
                    >
                      {d.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <Link href="/studio" className="btn btn-primary mt-2 w-full">Launch App <span aria-hidden>↗</span></Link>
        </aside>

        <article className="doc min-w-0 max-w-3xl">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href = "", children }) =>
                /^https?:/.test(href) ? (
                  <a href={href} target="_blank" rel="noreferrer">{children}</a>
                ) : (
                  <Link href={href.startsWith("/") || href.startsWith("#") ? href : `/docs/${href.replace(/\.md$/, "")}`}>{children}</Link>
                ),
              table: ({ children }) => (
                <div className="doc-table">
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {md}
          </Markdown>
          <nav className="mt-16 grid grid-cols-2 gap-4 border-t border-line pt-6 text-[13px]">
            {prev ? <Link href={`/docs/${prev.slug}`} className="text-ink-3 hover:text-ink">← {prev.title}</Link> : <span />}
            {next ? <Link href={`/docs/${next.slug}`} className="justify-self-end text-ink-3 hover:text-ink">{next.title} →</Link> : <span />}
          </nav>
        </article>
      </div>
    </div>
  );
}
