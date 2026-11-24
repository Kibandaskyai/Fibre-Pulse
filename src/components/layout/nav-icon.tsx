import {
  AlertTriangle, BarChart3, Building2, CreditCard, FileSignature, FileText, Gauge, LayoutDashboard, LifeBuoy,
  Map, Network, Package, Receipt, RefreshCcw, ScrollText, Settings, ShieldCheck, Users, Wifi, Wrench,
} from "lucide-react";
import type { NavItem } from "./nav-config";

const ICONS = {
  overview: LayoutDashboard,
  customers: Users,
  packages: Package,
  subscriptions: RefreshCcw,
  payments: CreditCard,
  revenue: BarChart3,
  network: Network,
  map: Map,
  alerts: AlertTriangle,
  support: LifeBuoy,
  field: Wrench,
  reports: FileText,
  settings: Settings,
  tenants: Building2,
  agreements: FileSignature,
  invoices: Receipt,
  shield: ShieldCheck,
  audit: ScrollText,
  hotspot: Wifi,
} satisfies Record<NavItem["icon"], unknown>;

export function NavIcon({ name, className }: { name: NavItem["icon"]; className?: string }) {
  const Icon = ICONS[name] ?? Gauge;
  return <Icon className={className} aria-hidden />;
}
