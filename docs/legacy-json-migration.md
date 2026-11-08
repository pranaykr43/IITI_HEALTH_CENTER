# Legacy appointment JSON migration

The importer supports a narrow, repeatable path from `appointmentsdatabase.json` into an already existing Health Centre SQLite database. It does not migrate users, doctors, passwords, or login records.

## Dry run first

The default mode opens the target database read-only and prints aggregate counts only:

```bash
npm run migrate:legacy -- --source=appointmentsdatabase.json --db=data/health-centre.sqlite
```

It does not print patient names, email addresses, phone numbers, symptoms, record IDs, or password values. The source JSON is never modified.

## What is eligible

- The target database already contains a `patient` account with the same email, matched case-insensitively.
- The legacy row is unscheduled (`sheduledtime` is empty).
- Phone, age, symptoms, and days pass the current appointment validation rules.
- A stable key derived from the legacy `_id` (or row position when `_id` is absent) makes repeated imports idempotent. If the source row changes after import, the conflict is counted instead of creating a second appointment.

Rows with a scheduled time are counted for manual review because the legacy export does not provide a reliable doctor assignment or status. The legacy `date` field is not mapped to `requested_at`; its original meaning is ambiguous. Imported requests receive the current import time.

The importer never reads `loginadminsdatabase.json`, `logindoctorsdatabase.json`, or `loginstudentsdatabase.json`. Legacy plaintext passwords are not migrated. Provision accounts separately with a verified password-reset process before applying appointments.

## Apply

After reviewing the dry-run counts, verifying the target database and patient-account mappings, and taking a separate database backup, apply the eligible rows explicitly:

```bash
npm run migrate:legacy -- --source=appointmentsdatabase.json --db=data/health-centre.sqlite --apply
```

Each row is committed through the appointment service, so appointment, idempotency, audit, and outbox records stay consistent. If an import stops partway through, rerun the same command; already imported rows replay safely.

## Current local dry run

The local `appointmentsdatabase.json` contained 12 rows. Against the isolated demo database, the dry run found 0 eligible rows, 9 scheduled rows requiring manual review, 3 rows without a matching target patient, and 0 invalid rows. No legacy appointment was imported.
