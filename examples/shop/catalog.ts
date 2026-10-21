// The catalogue lives on the server. Prices are never taken from the browser.
export interface Product { id: string; name: string; blurb: string; priceCents: number; emoji: string }

export const PRODUCTS: Product[] = [
  { id: "beans", name: "Lagos Roast Beans", blurb: "250 g, medium roast, chocolate and orange peel.", priceCents: 1450, emoji: "☕" },
  { id: "mug", name: "Stoneware Mug", blurb: "Hand-glazed, 350 ml, dishwasher safe.", priceCents: 1800, emoji: "🏺" },
  { id: "kettle", name: "Gooseneck Kettle", blurb: "Pour-over precision, 0.9 L, matte black.", priceCents: 5900, emoji: "🫖" },
  { id: "filters", name: "Paper Filters ×100", blurb: "Unbleached cone filters, size 02.", priceCents: 650, emoji: "📄" },
  { id: "scale", name: "Brew Scale", blurb: "0.1 g resolution with built-in timer.", priceCents: 3400, emoji: "⚖️" },
  { id: "grinder", name: "Hand Grinder", blurb: "Steel burrs, 30 clicks of adjustment.", priceCents: 7200, emoji: "⚙️" },
];

export interface PricedLine { product: Product; qty: number }

/** Turns untrusted cart input into priced lines, or throws a message fit to show the shopper. */
export function priceCart(input: unknown): { lines: PricedLine[]; totalCents: number } {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Your cart is empty.");
  if (input.length > 50) throw new Error("Your cart is too large.");
  const merged = new Map<string, number>();
  for (const l of input as Array<{ id?: unknown; qty?: unknown }>) {
    const id = typeof l?.id === "string" ? l.id : "";
    const qty = l?.qty;
    if (!PRODUCTS.some((p) => p.id === id)) throw new Error("An item in your cart is no longer available.");
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new Error("Quantities must be between 1 and 20.");
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  const lines = [...merged].map(([id, qty]) => ({ product: PRODUCTS.find((p) => p.id === id)!, qty: Math.min(qty, 20) }));
  return { lines, totalCents: lines.reduce((s, l) => s + l.product.priceCents * l.qty, 0) };
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
