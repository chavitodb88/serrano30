# Serrano30 - Descarga automática de Notas Simples

Automatización para descargar notas simples con estado "Respondida" desde [sede.registradores.org](https://sede.registradores.org).

## Requisitos

- Node.js 18+
- Certificado digital del cliente en formato `.p12` o `.pfx`
- Contraseña (passphrase) del certificado

## Instalación

```bash
npm install
```

## Configuración

```bash
cp .env.example .env
```

Editar `.env`:

```env
CERT_PATH=./certificado.p12       # Ruta al archivo del certificado
CERT_PASSPHRASE=tu_contraseña     # Contraseña del certificado
DOWNLOAD_DIR=./descargas           # Carpeta destino de los PDFs
MAX_PAGES=0                        # 0 = todas las páginas, o número límite
```

Colocar el archivo `.p12`/`.pfx` en la raíz del proyecto (está en `.gitignore`).

## Uso

```bash
npm run download
```

## Flujo de la automatización

1. **Autenticación** con certificado digital (sin usuario/contraseña, sin captcha)
2. **Navega al listado** de solicitudes: `/site/usuario/solicitudes/listado`
3. **Recorre cada página** buscando filas con estado "Respondida"
4. **Entra en el detalle** de cada solicitud respondida
5. **Clic en "Realizar consulta online"** → abre el PDF
6. **Descarga el PDF** y lo guarda como `descargas/{CÓDIGO_REFERENCIA}.pdf`
7. **Registra** las ya descargadas en `descargas/.downloaded.json` para no repetir

## URLs del sitio

| Paso | URL |
|------|-----|
| Listado de solicitudes | `sede.registradores.org/site/usuario/solicitudes/listado?order=desc&orderBy=id&pageSize=10&page=N` |
| Detalle de solicitud | `sede.registradores.org/site/usuario/solicitud/detalle/{ID}` |
| PDF de nota online | `sede.registradores.org/site/solicitud/nota-online/{ID}` |

## Estructura de la tabla del listado

| Columna | Contenido |
|---------|-----------|
| CÓDIGO/REFERENCIA | Código (ej: U54PT33Q) + nombre (ej: BELLOTA). Es un enlace al detalle |
| SOLICITUD/REGISTRO | Tipo (Nota online) + registro (ej: ARENYS DE MAR) |
| SOLICITANTE | Nombre del solicitante |
| CREACIÓN | Fecha y hora |
| ESTADO | "En proceso" (icono reloj) o "Respondida" (icono check verde) |
| IMPORTE BASE | Precio (ej: 12,03€) - solo en respondidas |

## Pendiente

- [ ] **Probar autenticación con certificado** - el cliente proporcionará el `.p12` + passphrase
- [ ] **Validar navegación al listado** - confirmar si al acceder con certificado se llega directamente al listado o hay pasos intermedios (selección de perfil, cookies, etc.)
- [ ] **Ajustar selectores CSS** si la estructura real difiere - el script se lanza con `headless: false` para depuración
- [ ] **Cambiar a headless: true** una vez validado todo el flujo
- [ ] **Evaluar pageSize mayor** - actualmente usa pageSize=10, se podría subir para reducir navegación
