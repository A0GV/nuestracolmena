# Dossier de análisis — clon de TheHive

Fecha: 2026-11-03
Estado: análisis completado; listo para Fase 0 del clon.

## Documentos

| Documento | Contenido |
|---|---|
| `backend-thehive4.md` | Dominio, endpoints, permisos, Query DSL y reglas de negocio de TheHive 4.1.24 (AGPL). |
| `frontend-thehive4.md` | Rutas, pantallas, componentes, flujos y design system del frontend AngularJS de TheHive 4. |
| `thehive3-vs-4.md` | Comparativa 3.5.2 vs 4.1.24 y recomendación de qué tomar de cada una. |
| `clone-blueprint.md` | Arquitectura propuesta, modelo PostgreSQL, API, UI, seguridad y fases del clon. |

## Referencias open source

- TheHive 3.5.2 y 4.1.24: AGPL-3.0, repos archivados; sirven como referencia de dominio/API/frontend.
- TheHive 5/6: comercial (StrangeBee); solo se usó comportamiento observable y documentación pública. Este repositorio no incluye código, capturas, documentación ni assets de TheHive 5/6.
- No se reutilizó código, marca ni assets propietarios de TheHive 6.

## Próximo paso

Fase 0 del `clone-blueprint.md`: scaffold del monorepo (React + Vite + AntD 5 / NestJS + Prisma + PostgreSQL), auth y shell visual.
