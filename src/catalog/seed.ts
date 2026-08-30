import * as M from "../domain/money";
import type { Product } from "../domain/types";
import { CatalogRepository } from "./repository";

/**
 * "Bengaluru Ergo" — a mid-market office furniture merchant.
 *
 * Chosen because it has the two properties that make agentic commerce
 * interesting: considered purchases with real money attached (so a cap and an
 * approval threshold actually bite), and natural bundles (a chair wants a
 * footrest) so the growth half has something honest to recommend rather than
 * spam.
 */

function p(rupees: number): M.Paise {
  return M.paise(rupees);
}

export const SEED_PRODUCTS: Product[] = [
  {
    id: "ergo-chair-mesh-pro",
    title: "MeshPro Ergonomic Task Chair",
    description:
      "High-back mesh task chair with adjustable lumbar support, 4D armrests and a synchro-tilt mechanism. Rated for 8-hour continuous use.",
    category: "seating",
    price: p(18499),
    costFloor: p(12900),
    stock: 12,
    attributes: { material: "mesh", lumbar: true, armrests: "4d", warrantyYears: 3, maxLoadKg: 130 },
    tags: ["chair", "ergonomic", "office", "mesh", "task", " lumbar"],
    shipsInDays: 3,
  },
  {
    id: "ergo-chair-mesh-lite",
    title: "MeshLite Ergonomic Task Chair",
    description:
      "Mid-back mesh chair with fixed lumbar pad and 2D armrests. Good posture support for hybrid work setups.",
    category: "seating",
    price: p(9499),
    costFloor: p(6400),
    stock: 40,
    attributes: { material: "mesh", lumbar: true, armrests: "2d", warrantyYears: 2, maxLoadKg: 110 },
    tags: ["chair", "ergonomic", "office", "mesh", "budget", "hybrid"],
    shipsInDays: 2,
  },
  {
    id: "exec-chair-leather",
    title: "Executive Leather Chair",
    description: "Full-grain leather executive chair with tilt lock and polished aluminium base.",
    category: "seating",
    price: p(32999),
    costFloor: p(21500),
    stock: 5,
    attributes: { material: "leather", lumbar: true, armrests: "3d", warrantyYears: 5, maxLoadKg: 150 },
    tags: ["chair", "executive", "leather", "premium", "office"],
    shipsInDays: 5,
  },
  {
    id: "standing-desk-electric",
    title: "Altitude Electric Standing Desk 140x70",
    description:
      "Dual-motor sit-stand desk with 4 memory presets, anti-collision and a 140x70cm bamboo top.",
    category: "desks",
    price: p(27999),
    costFloor: p(19200),
    stock: 8,
    attributes: { motor: "dual", widthCm: 140, depthCm: 70, memoryPresets: 4, topMaterial: "bamboo" },
    tags: ["desk", "standing", "sit-stand", "electric", "adjustable", "bamboo"],
    shipsInDays: 6,
  },
  {
    id: "standing-desk-manual",
    title: "Altitude Manual Standing Desk 120x60",
    description: "Crank-operated sit-stand desk with a laminate top. Entry-level standing desk.",
    category: "desks",
    price: p(12499),
    costFloor: p(8100),
    stock: 22,
    attributes: { motor: "none", widthCm: 120, depthCm: 60, memoryPresets: 0, topMaterial: "laminate" },
    tags: ["desk", "standing", "manual", "budget", "crank"],
    shipsInDays: 4,
  },
  {
    id: "desk-converter-basic",
    title: "Riser Standing Desk Converter",
    description: "Clamps onto an existing desk to convert it to sit-stand. No tools required.",
    category: "desks",
    price: p(6499),
    costFloor: p(4100),
    stock: 35,
    attributes: { motor: "none", widthCm: 80, depthCm: 50, memoryPresets: 0, topMaterial: "mdf" },
    tags: ["desk", "converter", "riser", "budget", "retrofit"],
    shipsInDays: 2,
  },
  {
    id: "monitor-arm-dual",
    title: "Dual Monitor Arm, Gas Spring",
    description: "Gas-spring dual monitor arm, clamp or grommet mount, VESA 75/100, up to 9kg per arm.",
    category: "accessories",
    price: p(5299),
    costFloor: p(3200),
    stock: 60,
    attributes: { monitors: 2, mount: "clamp", vesa: "75/100", maxWeightKg: 9 },
    tags: ["monitor", "arm", "mount", "vesa", "dual", "accessory"],
    shipsInDays: 2,
  },
  {
    id: "footrest-ergo",
    title: "Ergo Footrest, Height Adjustable",
    description: "Tilting footrest with a non-slip surface and two height positions. Reduces lower-back strain.",
    category: "accessories",
    price: p(1899),
    costFloor: p(950),
    stock: 120,
    attributes: { adjustable: true, maxHeightCm: 12, nonSlip: true },
    tags: ["footrest", "ergonomic", "accessory", "posture", "comfort"],
    shipsInDays: 2,
  },
  {
    id: "lumbar-cushion",
    title: "Memory Foam Lumbar Cushion",
    description: "Memory foam lumbar support cushion with a washable cover and an adjustable strap.",
    category: "accessories",
    price: p(1299),
    costFloor: p(600),
    stock: 200,
    attributes: { material: "memory-foam", washable: true, strap: true },
    tags: ["cushion", "lumbar", "ergonomic", "foam", "accessory"],
    shipsInDays: 2,
  },
  {
    id: "keyboard-tray-underdesk",
    title: "Underdesk Keyboard Tray",
    description: "Sliding keyboard tray with a gel wrist rest. Frees desk space and lowers shoulder strain.",
    category: "accessories",
    price: p(3199),
    costFloor: p(1900),
    stock: 45,
    attributes: { sliding: true, wristRest: true, widthCm: 65 },
    tags: ["keyboard", "tray", "accessory", "ergonomic", "underdesk"],
    shipsInDays: 3,
  },
  {
    id: "desk-mat-xl",
    title: "XL Desk Mat, Felt",
    description: "90x40cm felt desk mat with a stitched edge. Protects the desk and tames cable clutter.",
    category: "accessories",
    price: p(1499),
    costFloor: p(700),
    stock: 150,
    attributes: { material: "felt", widthCm: 90, depthCm: 40 },
    tags: ["desk", "mat", "felt", "accessory", "xl"],
    shipsInDays: 2,
  },
  {
    id: "acoustic-panel-set",
    title: "Acoustic Panel Set, Pack of 6",
    description: "Hexagonal acoustic panels that cut echo in calls. Peel-and-stick mounting.",
    category: "accessories",
    price: p(4299),
    costFloor: p(2400),
    stock: 28,
    attributes: { panels: 6, shape: "hexagon", mounting: "adhesive" },
    tags: ["acoustic", "panel", "sound", "calls", "accessory"],
    shipsInDays: 3,
  },
  {
    id: "task-lamp-led",
    title: "LED Task Lamp, Adjustable Arm",
    description: "2700-6500K adjustable LED lamp with a swing arm and a clamp base. Flicker-free.",
    category: "accessories",
    price: p(3799),
    costFloor: p(2200),
    stock: 52,
    attributes: { colorTempRange: "2700-6500K", arm: true, base: "clamp" },
    tags: ["lamp", "led", "light", "task", "accessory"],
    shipsInDays: 2,
  },
  {
    id: "gift-card-office",
    title: "Bengaluru Ergo Gift Card",
    description: "Digital gift card. Non-discountable.",
    category: "gift_cards",
    price: p(5000),
    costFloor: p(5000),
    stock: 999,
    attributes: { digital: true, discountable: false },
    tags: ["gift", "card", "digital", "voucher"],
    shipsInDays: 0,
  },
];

export function seedCatalog(): number {
  const repo = new CatalogRepository();
  for (const product of SEED_PRODUCTS) repo.upsert(product);
  return SEED_PRODUCTS.length;
}

if (require.main === module) {
  const n = seedCatalog();
  console.log(`Seeded ${n} products.`);
}
