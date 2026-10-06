/**
 * Menú fijo de Carnicería La Central.
 *
 * Nombres y precios del menú impreso (octubre 2026). No hay pollo.
 * Carnes, cocido, pastor y carbón se cobran por kilo; las salsas, por pieza.
 * El carbón del menú se llama "Carbón fino". Si el cliente dice firo, fino o
 * carbón, es el mismo producto. La foto está en
 * `public/menus/carniceria-la-central.png`. El pie del arte dice $25 de envío
 * y servicio; ese número es el cargo al cliente y no se lee de la imagen.
 */

export const CARNICERIA_LA_CENTRAL_NOMBRE = "Carnicería La Central";
export const CARNICERIA_LA_CENTRAL_CATEGORIA = "Carnicerías";

/** PNG oficial del menú. Si falta en el deploy, el bot manda el menú en texto. */
export const CARNICERIA_LA_CENTRAL_MENU_PNG = "public/menus/carniceria-la-central.png";

/** URL opcional de la misma foto. No va en el schema obligatorio de env. */
export const CARNICERIA_MENU_IMAGE_ENV = "CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL";

export type CarniceriaCatalogRow = {
  nombreProducto: string;
  precio: number;
  categoria: "Res marinada" | "Res" | "Puerco" | "Carne de puerco al pastor" | "Embutidos" | "Extras";
};

export const CARNICERIA_LA_CENTRAL_PRODUCTOS: CarniceriaCatalogRow[] = [
  { nombreProducto: "Arrachera Marinada", precio: 280, categoria: "Res marinada" },
  { nombreProducto: "Bistec de res Marinada", precio: 210, categoria: "Res marinada" },
  { nombreProducto: "Peinesillo", precio: 215, categoria: "Res" },
  { nombreProducto: "Diezmillo", precio: 215, categoria: "Res" },
  { nombreProducto: "Bistec de res", precio: 210, categoria: "Res" },
  { nombreProducto: "Cocido de res", precio: 155, categoria: "Res" },
  { nombreProducto: "Chamberete", precio: 155, categoria: "Res" },
  { nombreProducto: "Ribeye de res con hueso", precio: 210, categoria: "Res" },
  { nombreProducto: "Pulpa de puerco", precio: 115, categoria: "Puerco" },
  { nombreProducto: "Costilla de puerco marinada", precio: 120, categoria: "Puerco" },
  { nombreProducto: "Bistec de puerco marinado", precio: 120, categoria: "Puerco" },
  { nombreProducto: "Bistec de puerco", precio: 120, categoria: "Puerco" },
  { nombreProducto: "Costilla de puerco", precio: 110, categoria: "Puerco" },
  { nombreProducto: "Carne de puerco al pastor", precio: 120, categoria: "Carne de puerco al pastor" },
  { nombreProducto: "Chorizo", precio: 115, categoria: "Embutidos" },
  { nombreProducto: "Chorizo Argentino", precio: 135, categoria: "Embutidos" },
  { nombreProducto: "Carbón fino", precio: 75, categoria: "Extras" },
  { nombreProducto: "Salsa BBQ", precio: 59, categoria: "Extras" },
  { nombreProducto: "Salsa Hot Wings", precio: 55, categoria: "Extras" },
];
