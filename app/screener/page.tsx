import type { Metadata } from "next";
import ScreenerView from "@/components/ScreenerView";

export const metadata: Metadata = { title: "Screener · orderflow" };

export default function Page() {
  return <ScreenerView />;
}
