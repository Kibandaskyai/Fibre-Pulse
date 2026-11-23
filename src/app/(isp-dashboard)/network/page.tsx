import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Network" };

export default function NetworkPage() {
  return <PlaceholderPage href="/network" />;
}
