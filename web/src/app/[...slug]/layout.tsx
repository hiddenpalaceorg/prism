import "cube/styles.css";
import type { ReactNode } from "react";

export default function WikiLayout({ children }: { children: ReactNode }) {
  return <div className="cube-root mx-auto max-w-5xl px-4 py-6">{children}</div>;
}
