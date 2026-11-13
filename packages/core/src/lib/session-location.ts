const regionNames =
  "DisplayNames" in Intl
    ? new Intl.DisplayNames(undefined, { type: "region" })
    : null;

function countryName(country: string) {
  const code = country.toUpperCase();

  // Cloudflare uses these non-ISO country codes for Tor and unknown origins.
  if (code === "T1") return "Tor";

  if (code === "XX") return "Unknown location";

  try {
    return regionNames?.of(code) ?? country;
  } catch {
    return country;
  }
}

export function formatSessionLocation(location: string | null) {
  if (!location) return "Location unavailable";
  const parts = location.split(", ").filter(Boolean);
  const country = parts.at(-1);

  if (country?.length === 2) {
    parts[parts.length - 1] = countryName(country);
  }

  return parts.join(", ");
}
