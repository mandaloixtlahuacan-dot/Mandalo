/**
 * Menú fijo de Carnicería La Central.
 *
 * Los nombres y precios son los de la lista de Víctor (octubre 2026), con
 * ortografía en español. El carbón es Firo (con R). No hay pollo: esta
 * carnicería no lo vende. Carnes y cocido se cobran por kilo; carbón y salsas
 * son pieza. La foto del menú no vive aquí: Víctor la deja en
 * `public/menus/carniceria-la-central.png` o en
 * `CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL`. Sin foto, el habla sigue saliendo
 * de estos nombres.
 */

export const CARNICERIA_LA_CENTRAL_NOMBRE = "Carnicería La Central";
export const CARNICERIA_LA_CENTRAL_CATEGORIA = "Carnicerías";

/** PNG que Víctor puede soltar en el repo. Mientras no esté, el bot manda el menú en texto. */
export const CARNICERIA_LA_CENTRAL_MENU_PNG = "public/menus/carniceria-la-central.png";

/** URL opcional de la misma foto. No va en el schema obligatorio de env. */
export const CARNICERIA_MENU_IMAGE_ENV = "CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL";

export type CarniceriaCatalogRow = {
  nombreProducto: string;
  precio: number;
  categoria: "Carnes" | "Extras";
};

export const CARNICERIA_LA_CENTRAL_PRODUCTOS: CarniceriaCatalogRow[] = [
  { nombreProducto: "Arrachera Marinada", precio: 280, categoria: "Carnes" },
  { nombreProducto: "Bistec de res Marinada", precio: 210, categoria: "Carnes" },
  { nombreProducto: "Chorizo", precio: 115, categoria: "Carnes" },
  { nombreProducto: "Chorizo Argentino", precio: 135, categoria: "Carnes" },
  { nombreProducto: "Costilla de puerco marinada", precio: 120, categoria: "Carnes" },
  { nombreProducto: "Bistec de puerco marinado", precio: 120, categoria: "Carnes" },
  { nombreProducto: "Carne al pastor", precio: 120, categoria: "Carnes" },
  { nombreProducto: "Peinesillo", precio: 215, categoria: "Carnes" },
  { nombreProducto: "Diezmillo", precio: 215, categoria: "Carnes" },
  { nombreProducto: "Bistec de res", precio: 210, categoria: "Carnes" },
  { nombreProducto: "Cocido de res", precio: 155, categoria: "Carnes" },
  { nombreProducto: "Chamberete", precio: 155, categoria: "Carnes" },
  { nombreProducto: "Bistec de puerco", precio: 120, categoria: "Carnes" },
  { nombreProducto: "Costilla de puerco", precio: 110, categoria: "Carnes" },
  { nombreProducto: "Ribeye de res con hueso", precio: 210, categoria: "Carnes" },
  { nombreProducto: "Carbón Firo", precio: 75, categoria: "Extras" },
  { nombreProducto: "Salsa BBQ", precio: 59, categoria: "Extras" },
  { nombreProducto: "Salsa Hot Wings", precio: 55, categoria: "Extras" },
];
