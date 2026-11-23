import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Support" };

export default function SupportPage() {
  return <PlaceholderPage href="/support" />;
}
