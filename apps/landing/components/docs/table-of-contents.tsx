"use client";

import { ChevronDown, List } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Heading = { id: string; title: string };

export function InlineTableOfContents({ headings }: { headings: Heading[] }) {
  const details = useRef<HTMLDetailsElement>(null);
  return (
    <details className="docs-inline-toc" ref={details}>
      <summary><List size={15} aria-hidden="true" /> On this page <ChevronDown size={15} aria-hidden="true" /></summary>
      <nav aria-label="Page sections">
        {headings.map((heading) => (
          <a href={`#${heading.id}`} key={heading.id} onClick={() => { if (details.current) details.current.open = false; }}>
            {heading.title}
          </a>
        ))}
      </nav>
    </details>
  );
}

export function TableOfContents({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = headings[0]?.id ?? "";
      for (const heading of headings) {
        const element = document.getElementById(heading.id);
        if (element && element.getBoundingClientRect().top <= 160) current = heading.id;
      }
      // The final section may be too short to reach the top of the viewport.
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        current = headings.at(-1)?.id ?? current;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [headings]);

  return (
    <nav aria-label="On this page">
      <p>
        <List size={15} aria-hidden="true" /> On this page
      </p>
      <ul>
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              aria-current={active === heading.id ? "location" : undefined}
            >
              {heading.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
