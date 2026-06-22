import Link from "next/link";

// A block-level link that fills its table cell, so any click in the cell navigates
// (and the browser shows the destination in the status bar). Set `focusable` on one
// cell per row — the rest are hidden from the keyboard/screen-reader tree to avoid
// announcing the same link five times.
//
// Prefetch is off: the target /builds/[sha256] is force-dynamic and very expensive
// (similarity + embedding scans per load). With hundreds of rows × cells scrolling
// into view, default viewport prefetch would stampede the server and exhaust RAM.
export default function RowLink({
  href,
  children,
  className = "",
  focusable = false,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  focusable?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      tabIndex={focusable ? undefined : -1}
      aria-hidden={focusable ? undefined : true}
      className={`block h-full py-1 ${className}`}
    >
      {children}
    </Link>
  );
}
