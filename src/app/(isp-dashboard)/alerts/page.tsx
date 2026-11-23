import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shared/placeholder-page";

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsPage() {
  return <PlaceholderPage href="/alerts" />;
}
