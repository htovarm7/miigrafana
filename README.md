# miigrafana

Stack de observabilidad (Grafana + Loki + Prometheus) para **MiiCel Back**. Es un repo **independiente** de `MiiCelBack`, pensado para vivir como carpeta hermana:

```
miicel/
├── MiiCelBack/   (el backend .NET)
└── miigrafana/   (este repo)
```

Este repo **no reemplaza nada** de `MiiCelBack` — solo agrega infraestructura de logs/métricas/dashboards que se conecta al backend por red (Docker) o por `localhost` (cuando el backend corre con `dotnet run`).

- [`OBSERVABILIDAD.md`](OBSERVABILIDAD.md) — la propuesta completa: por qué Grafana y no Seq, arquitectura, plan de fases, impacto en recursos.
- [`observability/README.md`](observability/README.md) — la guía operativa detallada (troubleshooting de puertos en Windows, cómo se corta el ruido de logs, retención de 90 días, cómo pasar a Docker completo).

Este README es el punto de entrada rápido: cómo levantar el stack y cómo conectarlo al resto de MiiCel.

## 1. Levantar el stack

Requisitos: Docker Desktop.

```bash
docker compose -f docker-compose.observability.yml up -d
```

Esto levanta:

| Servicio | URL local | Para qué |
|---|---|---|
| Grafana | http://localhost:3000 | Dashboards (login anónimo como admin, solo para uso local) |
| Prometheus | http://localhost:9090 | Métricas / targets |
| Loki | http://localhost:3200 | Logs (puerto remapeado de 3100 por el rango excluido de Windows/Hyper-V) |

Para bajarlo: `docker compose -f docker-compose.observability.yml down` (agrega `-v` si además quieres borrar el historial de logs/métricas).

## 2. Conectarlo con MiiCel Back

Hoy la única API con la instrumentación ya integrada es **`MiiCel.Api.Management`** (rama `grafana-smoke-test` de `MiiCelBack`). Users y Workers todavía no tienen el wiring — se replica el mismo patrón cuando el equipo decida avanzar a esa fase (ver "Implementation plan" en `OBSERVABILIDAD.md`).

La conexión son dos piezas, ambas ya presentes en `MiiCelBack` sobre esa rama:

1. **Logs → Loki**: sink `GrafanaLoki` en `MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/appsettings.Development.json`, apuntando a `http://localhost:3200` (porque la API corre con `dotnet run` en el host, no en Docker).
2. **Métricas → Prometheus**: `AddOpenTelemetry()...AddPrometheusExporter()` + `MapPrometheusScrapingEndpoint()` en `Program.cs`, expuesto en `GET /metrics`. `observability/prometheus/prometheus.yml` scrapea eso vía `host.docker.internal:5011` (el puerto del perfil `http` de Management, ver `launchSettings.json`).

Para probarlo de punta a punta:

```bash
# 1) Stack de observabilidad (este repo)
docker compose -f docker-compose.observability.yml up -d

# 2) Management API (repo MiiCelBack, rama grafana-smoke-test)
dotnet run --project ../MiiCelBack/src/MiiCel.Api/MiiCel.Api.Management/MiiCel.Api.Management.csproj
```

Luego abre Grafana en http://localhost:3000 → dashboard **"MiiCel Back - Management (local)"** (carpeta "MiiCel"). El paso a paso completo de verificación (targets de Prometheus, disparar un error a propósito, ver el log en Loki) está en [`observability/README.md`](observability/README.md#how-to-test-it).

> Cuando se quiera correr todo dentro de Docker (API incluida), el mismo `observability/README.md` documenta cómo combinar los compose de ambos repos en un solo comando (sección "Switching to a fully dockerized API later").

## 3. Auditoría: "qué hizo el usuario X antes de que Y se cayera"

Esta es la pregunta que el equipo quiere poder responder sin SSH ni leer logs uno por uno, y ya está resuelta con lo que hay en la rama `grafana-smoke-test`:

- `Program.cs` en Management enriquece **cada request autenticado** con `UserId` (del claim JWT) y `Endpoint`. No hay que tocar cada controller.
- El endpoint de prueba `GET /api/home/test-error?userId=...&reason=...` (en `HomeController.cs`) simula una falla real con esos mismos campos, para probar el flujo sin necesitar un JWT real.
- Solo se audita lo que realmente sirve para debuguear: **errores** (`level="error"`), no todo el tráfico — así el ruido de requests normales/scrapes de `/metrics` no tapa la falla real.

### Cómo consultarlo

**Dashboard** (ambos, Management y Users): variable **`UserId (auditoria)`** arriba del dashboard + el panel **"Auditoria: que hizo el usuario $userId antes de fallar"**. Escribe el `UserId` (o déjalo en `.+` para ver todos) y el panel filtra en vivo solo los errores de ese usuario, con la excepción completa.

**Explore → Loki**, si prefieres LogQL directo:

```
{app="miicel-api-management"} | json | level="error" | UserId="8842"
```

Ejemplo reproducible sin JWT real:

```bash
curl "http://localhost:5011/api/home/test-error?userId=8842&reason=saldo-insuficiente"
curl "http://localhost:5011/api/home/test-error?userId=1900&reason=telefono-invalido"
```

La primera consulta regresa solo el fallo de `8842` (tipo de excepción, mensaje, stack trace completo) y filtra el de `1900`. En producción, con un JWT real, `UserId` es el mismo claim `NameIdentifier` que ya usan los controllers — el soporte puede pasar de "el usuario dice que la recarga X falló" directo a la línea de log exacta.

Detalle completo (por qué se separaron los paneles de logs, cómo se cortó el ruido de `Microsoft.AspNetCore` y de los scrapes de `/metrics`, retención de 90 días) en la sección ["Finding what did this specific user do that broke"](observability/README.md#finding-what-did-this-specific-user-do-that-broke) de `observability/README.md`.

## Estado de las ramas

- `MiiCelBack`: todo el trabajo de observabilidad vive en la rama **`grafana-smoke-test`** (no en `master`/`main`). Verifica que estés parado ahí (`git branch --show-current` dentro de `MiiCelBack`) antes de tocar código de instrumentación.
- `miigrafana` (este repo): solo tiene `main`, no hay restricción especial — los cambios de infra/dashboards se hacen directo ahí.
