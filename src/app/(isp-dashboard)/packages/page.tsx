import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Packages" };

export default function PackagesPage() {
  return <PlaceholderPage href="/packages" />;
}
