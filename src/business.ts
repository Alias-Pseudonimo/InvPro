import { api } from "./api";
import type { Setting } from "./types";
import { useLoad } from "./ui";

/** Who the business is, on paper: the details printed on every document. */
export interface BusinessProfile {
  address: string;
  phone: string;
  email: string;
  website: string;
}

export const EMPTY_PROFILE: BusinessProfile = { address: "", phone: "", email: "", website: "" };

export function profileFromSettings(rows: Setting[]): BusinessProfile {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const read = (key: string) => (map.get(key) ?? "").trim();
  return {
    address: read("business_address"),
    phone: read("business_phone"),
    email: read("business_email"),
    website: read("business_website"),
  };
}

/** The company's details as saved in Settings → Business details. */
export function useBusinessProfile(revision: number): BusinessProfile {
  const rows = useLoad(() => api.listSettings(), [revision]).data;
  return rows ? profileFromSettings(rows) : EMPTY_PROFILE;
}
