export interface MenuItem {
  name: string;
  price: number;
}

export interface Vendor {
  id: string;
  name: string;
  status: "active" | "closed";
  sampleDescription: string;
  minPrice: number;
  items: MenuItem[];
}

export const VENDORS: Vendor[] = [
  // Page 1
  {
    id: "ice_vendor",
    name: "Ice Vendor",
    status: "active",
    sampleDescription: "Sells Ice",
    minPrice: 200,
    items: [
      { name: "Ice Block", price: 200 },
      { name: "Cold Bottled Water", price: 200 },
      { name: "Chilled Soft Drinks", price: 350 }
    ]
  },
  {
    id: "grandpa_chips",
    name: "Grandpa Chips",
    status: "active",
    sampleDescription: "Sells Beef, Plastic Pack, Egg, Sausage",
    minPrice: 200,
    items: [
      { name: "Egg", price: 200 },
      { name: "Plastic Pack", price: 200 },
      { name: "Sausage", price: 300 },
      { name: "Beef", price: 400 },
      { name: "Crispy Chips (Regular)", price: 1200 },
      { name: "Chips + Egg Combo", price: 1500 },
      { name: "Chips + Sausage Combo", price: 1700 },
      { name: "Chips + Beef Combo", price: 1800 },
      { name: "Chips + Fried Chicken", price: 2300 }
    ]
  },
  {
    id: "delish_yamarita",
    name: "Delish Yamarita",
    status: "active",
    sampleDescription: "Sells Egg, Pepper Stew, Ponmo, Sausage",
    minPrice: 300,
    items: [
      { name: "Egg", price: 300 },
      { name: "Ponmo", price: 300 },
      { name: "Pepper Stew", price: 400 },
      { name: "Sausage", price: 400 },
      { name: "Delish Pack + 1 Kebab", price: 2200 },
      { name: "Delish Pack + 2 Kebabs", price: 2600 },
      { name: "Delish Pack + 3 Kebabs", price: 3000 },
      { name: "Delish Pack + 4 Kebabs", price: 3400 },
      { name: "Delish Pack + 5 Kebabs", price: 3800 },
      { name: "Kings Pack + 1 Kebab", price: 3000 },
      { name: "Kings Pack + 2 Kebabs", price: 3400 },
      { name: "Kings Pack + 3 Kebabs", price: 3800 }
    ]
  },
  {
    id: "bread_warmer",
    name: "Bread Warmer",
    status: "active",
    sampleDescription: "Sells Bread Warmer + 1 Sausage, Bread Warmer + 2 Sausages, Bread Warmer + 3 Sausages, Jumbo Bread Warmer + 2 Sausages",
    minPrice: 1900,
    items: [
      { name: "Bread Warmer + 1 Sausage", price: 1900 },
      { name: "Bread Warmer + 2 Sausages", price: 2300 },
      { name: "Bread Warmer + 3 Sausages", price: 2700 },
      { name: "Jumbo Bread Warmer + 2 Sausages", price: 2900 },
      { name: "Extra Sausage", price: 400 },
      { name: "Extra Cheese Melt", price: 500 }
    ]
  },
  {
    id: "burritos",
    name: "Burritos",
    status: "active",
    sampleDescription: "Sells Sausage, Burrito, Chicken Only (Regular), Chicken Only (Super)",
    minPrice: 300,
    items: [
      { name: "Sausage", price: 300 },
      { name: "Chicken Only (Regular)", price: 1500 },
      { name: "Classic Beef Burrito", price: 1800 },
      { name: "Chicken Only (Super)", price: 2200 },
      { name: "Super Loaded Chicken Burrito", price: 2500 }
    ]
  },

  // Page 2
  {
    id: "cu_pizza",
    name: "CU Pizza",
    status: "active",
    sampleDescription: "Sells Extra Cheese, Beef Pizza Burger (Regular), Chicken Pizza Burger (Regular), Egg Beef Pizza Burger",
    minPrice: 700,
    items: [
      { name: "Extra Cheese", price: 700 },
      { name: "Beef Pizza Burger (Regular)", price: 2000 },
      { name: "Chicken Pizza Burger (Regular)", price: 2200 },
      { name: "Egg Beef Pizza Burger", price: 2400 },
      { name: "Personal Pepperoni Pizza", price: 3200 },
      { name: "Medium BBQ Chicken Pizza", price: 4500 }
    ]
  },
  {
    id: "abacha_vendor",
    name: "Abacha Vendor",
    status: "active",
    sampleDescription: "Sells Plantain, Pepper Sauce (per spoon), Plastic Pack, Beef",
    minPrice: 100,
    items: [
      { name: "Plastic Pack", price: 100 },
      { name: "Pepper Sauce (per spoon)", price: 200 },
      { name: "Plantain", price: 300 },
      { name: "Beef", price: 500 },
      { name: "Abacha Special Plate", price: 1500 },
      { name: "Abacha + Fried Fish", price: 2200 },
      { name: "Abacha Deluxe (Fish + Ponmo + Kpomo)", price: 2800 }
    ]
  },
  {
    id: "suya_spot",
    name: "Suya Spot",
    status: "active",
    sampleDescription: "Sells Suya (₦500), Special Suya, Suya (₦1,000), Suya (₦1,500)",
    minPrice: 500,
    items: [
      { name: "Suya (₦500)", price: 500 },
      { name: "Suya (₦1,000)", price: 1000 },
      { name: "Suya (₦1,500)", price: 1500 },
      { name: "Special Beef Suya (Large)", price: 2000 },
      { name: "Chicken Suya Combo", price: 2500 },
      { name: "Masa + Suya Deluxe", price: 2800 }
    ]
  },
  {
    id: "emabuop_g_foods",
    name: "Emabuop.G Foods",
    status: "active",
    sampleDescription: "Sells Ponmo (Small), Beef, Plastic Pack, Sliced Fish",
    minPrice: 100,
    items: [
      { name: "Plastic Pack", price: 100 },
      { name: "Ponmo (Small)", price: 200 },
      { name: "Beef", price: 400 },
      { name: "Sliced Fish", price: 600 },
      { name: "Jollof Rice (Standard Pack)", price: 1200 },
      { name: "Fried Rice (Standard Pack)", price: 1200 },
      { name: "Jollof + Fried Chicken", price: 2200 }
    ]
  },
  {
    id: "breakthrough_pizza",
    name: "Breakthrough Pizza",
    status: "active",
    sampleDescription: "Sells Pizza Burger (Regular), Pizza Burger + Extra Chicken & Sausage, Pepperoni Pizza (Regular), Pizza Burger + Extra Chicken, Sausage & Cheese",
    minPrice: 1500,
    items: [
      { name: "Pizza Burger (Regular)", price: 1500 },
      { name: "Pepperoni Pizza (Regular)", price: 2400 },
      { name: "Pizza Burger + Extra Chicken & Sausage", price: 2800 },
      { name: "Pizza Burger + Extra Chicken, Sausage & Cheese", price: 3200 },
      { name: "Supreme BBQ Meat Lovers Pizza", price: 4800 }
    ]
  },

  // Page 3
  {
    id: "dg_and_g_boli",
    name: "DG and G Boli",
    status: "active",
    sampleDescription: "Sells Ponmo, Plastic Pack, Beef, Egg",
    minPrice: 100,
    items: [
      { name: "Plastic Pack", price: 100 },
      { name: "Egg", price: 200 },
      { name: "Ponmo", price: 300 },
      { name: "Beef", price: 500 },
      { name: "Roasted Plantain (Boli) Single", price: 500 },
      { name: "Boli + Pepper Sauce + Groundnut", price: 900 },
      { name: "Boli + Grilled Fish Deluxe", price: 2200 }
    ]
  },
  {
    id: "cu_spicy",
    name: "CU Spicy",
    status: "active",
    sampleDescription: "Sells Fish (Small), Ponmo, Round Fish, Fish (Medium)",
    minPrice: 200,
    items: [
      { name: "Ponmo", price: 200 },
      { name: "Fish (Small)", price: 400 },
      { name: "Round Fish", price: 600 },
      { name: "Fish (Medium)", price: 800 },
      { name: "Spicy Spaghetti + Chicken", price: 2000 },
      { name: "Spicy Rice + Turkey", price: 2800 }
    ]
  },
  {
    id: "the_fruits_place",
    name: "The Fruits Place",
    status: "active",
    sampleDescription: "Sells Orange (each), Apple (Small), Bananas (Small), Pawpaw (Cut)",
    minPrice: 200,
    items: [
      { name: "Orange (each)", price: 200 },
      { name: "Apple (Small)", price: 300 },
      { name: "Bananas (Small bunch)", price: 400 },
      { name: "Pawpaw (Cut)", price: 500 },
      { name: "Watermelon Bowl (Chilled)", price: 600 },
      { name: "Mixed Fruit Salad Bowl", price: 1200 }
    ]
  },
  {
    id: "choice_waffles",
    name: "Choice Waffles",
    status: "active",
    sampleDescription: "Sells Egg Sauce, Fried Egg, Plastic Pack, Sausage (Cut & Peppered)",
    minPrice: 200,
    items: [
      { name: "Plastic Pack", price: 200 },
      { name: "Fried Egg", price: 300 },
      { name: "Egg Sauce", price: 500 },
      { name: "Sausage (Cut & Peppered)", price: 600 },
      { name: "Golden Belgian Waffles + Syrup", price: 1800 },
      { name: "Waffles + Scrambled Eggs & Sausage", price: 2600 }
    ]
  },
  {
    id: "pizza_republic_633",
    name: "6:33 Pizza Republic",
    status: "active",
    sampleDescription: "Sells Extra Chicken (Topping), Extra Cheese (Topping), Burger, Chicken BBQ Pizza (Small)",
    minPrice: 500,
    items: [
      { name: "Extra Cheese (Topping)", price: 500 },
      { name: "Extra Chicken (Topping)", price: 600 },
      { name: "Classic Beef Burger", price: 1800 },
      { name: "Chicken BBQ Pizza (Small)", price: 2800 },
      { name: "Pepperoni Passion (Medium)", price: 4200 }
    ]
  },

  // Page 4
  {
    id: "slash_shawarma",
    name: "Slash Shawarma",
    status: "active",
    sampleDescription: "Sells Shawarma + 1 Sausage, Shawarma + 2 Sausages, Shawarma + 2 Sausages & Extra Chicken, Shawarma + 3 Sausages & Extra Chicken",
    minPrice: 2000,
    items: [
      { name: "Shawarma + 1 Sausage", price: 2000 },
      { name: "Shawarma + 2 Sausages", price: 2400 },
      { name: "Shawarma + 2 Sausages & Extra Chicken", price: 2800 },
      { name: "Shawarma + 3 Sausages & Extra Chicken", price: 3200 }
    ]
  },
  {
    id: "mary_j_413",
    name: "Mary J 4:13",
    status: "closed",
    sampleDescription: "Sells Parfait (Small), Parfait (Medium), Oreo Milkshake (Small), Shortbread Milkshake (Small)",
    minPrice: 1000,
    items: [
      { name: "Parfait (Small)", price: 1000 },
      { name: "Parfait (Medium)", price: 1600 },
      { name: "Oreo Milkshake (Small)", price: 1800 },
      { name: "Shortbread Milkshake (Small)", price: 1800 },
      { name: "Super Rich Parfait (Large)", price: 2500 }
    ]
  },
  {
    id: "evelyn_concept",
    name: "Evelyn Concept",
    status: "closed",
    sampleDescription: "Sells Beef, Plantain, Plastic Pack, Ponmo",
    minPrice: 200,
    items: [
      { name: "Plastic Pack", price: 200 },
      { name: "Plantain", price: 300 },
      { name: "Ponmo", price: 300 },
      { name: "Beef", price: 500 },
      { name: "Fried Yamarita + Egg & Pepper Stew", price: 1800 }
    ]
  },
  {
    id: "fish_and_chips",
    name: "Fish and Chips",
    status: "closed",
    sampleDescription: "Sells Catfish (No Chips), Catfish & Chips, Tilapia (Regular, No Chips), Tilapia & Chips (Regular)",
    minPrice: 2100,
    items: [
      { name: "Catfish (No Chips)", price: 2100 },
      { name: "Tilapia (Regular, No Chips)", price: 2400 },
      { name: "Catfish & Chips", price: 2700 },
      { name: "Tilapia & Chips (Regular)", price: 3000 }
    ]
  }
];

export const PAGE_SIZE = 5;
export const TOTAL_PAGES = Math.ceil(VENDORS.length / PAGE_SIZE); // 4 pages
