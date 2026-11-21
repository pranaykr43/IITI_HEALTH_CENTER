# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: patients seeking campus care.** They need a clear way to request an appointment, follow its status, and find the prescription recorded for a completed visit.
- **Doctors:** They need to see appointments assigned to them, manage consultations, and record visit outcomes and prescriptions.
- **Health Centre administrators:** They need to schedule appointments, provision and manage accounts, and inspect notification operations.

## Product Purpose

Health Centre provides a clear appointment coordination path for patients and care team staff: request, scheduling, visit recording, and follow-up. Success means patients can find appointment access and account help easily, while staff can complete their part within role boundaries. The application is an independent academic demonstration, not an endorsed or live health service, and must not imply that it is a production medical-record service.

## Positioning

A patient-facing Health Centre website backed by a small Express and SQLite application. It provides patient account access, appointment state and scheduling, role-based staff workflows, and durable notification events. The current project is not a live campus service or a production clinical system.

## Operating Context

- People use the application through a web browser.
- Patients can register or sign in. Doctor and administrator accounts are provisioned through trusted operations rather than public registration.
- Administrators schedule requests; assigned doctors complete visits and record prescriptions; patients review appointment status and visit details.
- The repository runs locally with seeded synthetic accounts and a local SQLite file. The standalone notification worker uses a console adapter by default and does not send email.
- Google sign-in is optional and requires deployment configuration. The flow has automated tests with mocked provider responses; it has not been verified with a real Google project.

## Capabilities and Constraints

- The active application is server-rendered with Express and EJS, with SQLite persistence. Preserve this architecture and its low-infrastructure local setup.
- Patient, doctor, and administrator capabilities are separated by server-side roles. Patient registration must not provision staff roles.
- Appointment changes, audit events, and notification outbox records are designed to commit transactionally. Appointment requests support idempotent retries and scheduling rejects a duplicate doctor/time slot.
- The notification worker provides at-least-once delivery semantics. The built-in adapter only logs locally; real email delivery is not implemented.
- Keep the independent academic demonstration disclosure discreet but visible in the footer and relevant forms. Avoid claims of IIT Indore affiliation, HIPAA compliance, production readiness, clinical suitability, live provider delivery, or exactly-once external effects.
- Password sign-in remains available when Google credentials are absent. Google sign-in is patient-only and is not considered production-verified until real credentials and the live callback are configured and tested.

## Brand Commitments

- The product name is **Health Centre**.
- Preserve the current product name. No additional logo or brand asset was established in the repository.

## Evidence on Hand

- `README.md` and `docs/technical-design.md` describe the product scope, role workflows, architecture, and operating limits.
- The active Express routes, EJS views, SQLite migrations, and automated tests demonstrate the appointment and account workflows.
- The repository contains no verified customer testimonials, live campus integration, real notification-provider evidence, or real Google OAuth configuration. Do not invent or imply any of these.

## Product Principles

1. Make the patient’s next step clear.
2. Keep patient, doctor, and administrator access distinct and enforced by the server.
3. Preserve appointment and notification state across retries and process failures.
4. Keep the local setup small and understandable.
5. State clearly what the demonstration does and what has not been integrated or verified without turning the homepage into a showcase or demo launcher.

## Accessibility & Inclusion

The existing web tests check keyboard access, responsive layouts, accessible form use, and axe rules tagged WCAG 2.1 A/AA. Preserve these checks as the interface evolves.
