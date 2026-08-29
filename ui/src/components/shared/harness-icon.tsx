import type { ReactElement, SVGProps } from "react";
import { cn } from "@/lib/utils";

// Inline SVGs (paths from agent-swarm-internal/apps/web/public/harness-logos/).
// We render them as inline <svg> rather than <img src=...>:
//
//   - <img> on an SVG with an embedded <title> can surface the title as a
//     native browser tooltip on some platforms; rendering inline gives us
//     full control over what's exposed to AT and to hover.
//   - We don't render <title> elements, and the wrapper sets aria-hidden so
//     no accessible name leaks. The harness label next to the icon is the
//     accessible name.

type IconProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "fill" | "xmlns" | "children">;

const ICON_BASE: SVGProps<SVGSVGElement> = {
  fill: "currentColor",
  fillRule: "evenodd",
  viewBox: "0 0 24 24",
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true,
  focusable: false,
};

function ClaudeIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, harness label provides accessible name
    <svg aria-hidden {...ICON_BASE} {...props}>
      <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" />
    </svg>
  );
}

function ClaudeManagedIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, harness label provides accessible name
    <svg aria-hidden {...ICON_BASE} {...props}>
      <path
        opacity="0.55"
        d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"
      />
      <circle cx="19.6" cy="4.4" r="2.4" />
    </svg>
  );
}

function CodexIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, harness label provides accessible name
    <svg aria-hidden {...ICON_BASE} {...props}>
      <path d="M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2zm0 1.875A8.125 8.125 0 1 0 20.125 12 8.135 8.135 0 0 0 12 3.875zM12 7l5 5-5 5-5-5z" />
    </svg>
  );
}

function PiIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, harness label provides accessible name
    <svg aria-hidden {...ICON_BASE} {...props}>
      <path d="M3 6.5h18v3h-3.2v6.3c0 .55.4.95.95.95.55 0 .95-.4.95-.95V14h2.3v1.8c0 1.82-1.43 3.25-3.25 3.25-1.82 0-3.25-1.43-3.25-3.25V9.5h-3.6V19h-3V9.5H6.2V19h-3V9.5H3v-3z" />
    </svg>
  );
}

function OpencodeIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, harness label provides accessible name
    <svg aria-hidden {...ICON_BASE} {...props}>
      <path d="M4 4h16v16H4V4zm2 2v12h12V6H6zm2 3l4 3-4 3V9zm6 5h4v2h-4v-2z" />
    </svg>
  );
}

function DevinIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, harness label provides accessible name
    <svg aria-hidden {...ICON_BASE} {...props}>
      <path d="M3 3h7.4c5.16 0 8.6 3.7 8.6 9s-3.44 9-8.6 9H3V3zm3 3v12h4.4c3.5 0 5.6-2.4 5.6-6s-2.1-6-5.6-6H6z" />
      <circle cx="20.5" cy="12" r="1.6" />
    </svg>
  );
}

const ICON_BY_HARNESS: Record<string, (p: IconProps) => ReactElement> = {
  claude: ClaudeIcon,
  "claude-managed": ClaudeManagedIcon,
  codex: CodexIcon,
  pi: PiIcon,
  opencode: OpencodeIcon,
  devin: DevinIcon,
};

export interface HarnessIconProps extends IconProps {
  harness: string | null | undefined;
}

export function HarnessIcon({ harness, className, ...rest }: HarnessIconProps) {
  if (!harness) return null;
  const Icon = ICON_BY_HARNESS[harness];
  if (!Icon) return null;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0 opacity-80", className)} {...rest} />;
}
