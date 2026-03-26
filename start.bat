@echo off
title Serrano30
color 1F
echo.
echo  ========================================
echo         SERRANO30 - Notas Simples
echo  ========================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js no esta instalado.
    echo  Descargar desde: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Show Node version
for /f "tokens=*" %%i in ('node -v') do echo  Node.js %%i detectado.

:: First run: install dependencies
if not exist "node_modules" (
    echo.
    echo  Primera ejecucion: instalando dependencias...
    echo  Esto puede tardar unos minutos.
    echo.
    call npm install --production
    if %errorlevel% neq 0 (
        echo.
        echo  [ERROR] Fallo al instalar dependencias.
        pause
        exit /b 1
    )
    echo.
    echo  Dependencias instaladas correctamente.
)

:: Create .env if missing
if not exist ".env" (
    echo.
    echo  [CONFIGURACION] No se encontro archivo .env
    echo  Creando desde plantilla...
    copy .env.example .env >nul
    echo.
    echo  IMPORTANTE: Debes editar el archivo .env con tus datos:
    echo    - ADMIN_USER y ADMIN_PASSWORD (credenciales de acceso)
    echo    - OPENAI_API_KEY (clave de API para analisis)
    echo    - SESSION_SECRET (se genera automaticamente si no lo pones)
    echo.
    echo  Se abrira el archivo para que lo edites ahora.
    echo  Guarda y cierra cuando termines.
    echo.
    notepad .env
    pause
)

:: Check if port 3000 is already in use
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (
    echo.
    echo  Serrano30 ya esta en ejecucion.
    echo  Abriendo navegador...
    start http://localhost:3000
    timeout /t 3 /nobreak >nul
    exit /b 0
)

:: Start server
echo.
echo  Iniciando servidor...
start /min "Serrano30 Server" cmd /c "node src/app.js"

:: Wait for server to be ready
echo  Esperando a que el servidor este listo...
set /a attempts=0
:waitloop
timeout /t 1 /nobreak >nul
set /a attempts+=1
if %attempts% gtr 15 (
    echo  [ERROR] El servidor no respondio a tiempo.
    pause
    exit /b 1
)
powershell -Command "try { (Invoke-WebRequest -Uri http://localhost:3000/login -UseBasicParsing -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>nul
if %errorlevel% neq 0 goto waitloop

:: Open browser
echo  Servidor listo. Abriendo navegador...
start http://localhost:3000
echo.
echo  ========================================
echo   Serrano30 esta funcionando.
echo   No cierres esta ventana mientras
echo   estes usando la aplicacion.
echo  ========================================
echo.
echo  Pulsa cualquier tecla para detener el servidor.
pause >nul

:: Stop server
echo.
echo  Deteniendo servidor...
taskkill /fi "WINDOWTITLE eq Serrano30 Server" /f >nul 2>nul
echo  Servidor detenido. Puedes cerrar esta ventana.
timeout /t 2 /nobreak >nul
