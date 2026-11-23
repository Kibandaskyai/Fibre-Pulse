import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Revenue" };

export default function RevenuePage() {
  return <PlaceholderPage href="/revenue" />;
}
