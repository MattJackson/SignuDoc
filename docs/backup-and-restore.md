# Backup and restore

A SignuDoc install keeps its records in two places: the Postgres database (accounts, envelopes, audit trails, settings) and its file store (the PDFs, sealed copies and certificates), which is a Vercel Blob store, a Google Cloud Storage bucket, or the machine's disk. This page covers what protects each one, how to turn on SignuDoc's own daily backup, and how to restore from it.

## What you have without doing anything

- **Neon** keeps the database's history for a restore window and can restore it to a point in time, or branch from it, from the Neon console. The window is short on the free plan and longer on paid plans; see Neon's plan page for the current numbers. It protects against a bad change, not against losing the Neon project or account.
- **Cloud SQL** keeps automated backups and, with point-in-time recovery, the write-ahead log, if you turn them on. Turn on both for the install's instance: **automated backups** (daily, kept 7 days or more) and **point-in-time recovery** (a few days of log). Then you can bring the database back to any minute in that window from the console or with `gcloud sql instances clone`. Like Neon's, these live with the instance and its project: they protect against a bad change, not against losing the project.
- **Vercel Blob** has no versions or recycle bin. A deleted file is gone.
- **Cloud Storage** keeps nothing deleted unless the bucket has object versioning or soft delete turned on (new buckets get 7 days of soft delete by default).

So the daily backup is worth turning on for any install whose documents matter. The database's own backups (Neon's history, or Cloud SQL's automated backups and point-in-time recovery) are the first layer; SignuDoc's backup is the copy that survives losing the whole project.

## Turn on the daily backup

The backup copies the install, once a day, to a place you keep apart from it: a second Vercel Blob store, or a Google Cloud Storage bucket. Use whichever matches where the install runs; either works whatever the install keeps its own files in.

An administrator sets it up under **Settings, Backups**: choose where backups go, press **Test destination** (it writes, lists, reads back and deletes a small file, and says what to fix if any of that fails), and save. **Run backup now** runs one straight away. The section shows how the last runs went, and every change there is recorded in the site audit trail.

The same choices can be fixed by the deployment instead, with environment variables. Set there, they win, and Settings shows them as set by the deployment:

| Variable                       | What it does                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_GCS_BUCKET`            | Back up to this Cloud Storage bucket. Takes precedence over `BACKUP_BLOB_READ_WRITE_TOKEN`.                                      |
| `BACKUP_GCS_PREFIX`            | Optional. A folder in that bucket for the backup.                                                                                |
| `BACKUP_BLOB_READ_WRITE_TOKEN` | Back up to the Blob store with this read-write token.                                                                            |
| `BACKUP_KEEP_DAYS`             | How many days database copies, and the copies of deleted files, are kept. 30 unless set (or chosen in Settings), from 1 to 3650. |

### Back up to Google Cloud Storage

1. **Make the backup bucket.** Make it in a different Google Cloud project from the install if you can, so that losing the install's project, or an owner there, does not take the backup with it. Turn on **uniform bucket-level access** and **public access prevention**.
2. **Turn on object versioning** for the bucket, with a lifecycle rule that deletes noncurrent versions after, say, 30 days. Then even a backup run that went wrong, or someone with access deleting files, can be undone for that long:

   ```sh
   gcloud storage buckets update gs://acme-signudoc-backups --versioning
   ```

   For a stronger guarantee, a [bucket retention policy](https://cloud.google.com/storage/docs/bucket-lock) stops anyone deleting a copy before it is a given age. Keep it shorter than `BACKUP_KEEP_DAYS`, or the backup's own clean-up of old copies fails.

3. **Let the app write to it.** Give the service account the app runs as `roles/storage.objectAdmin` on that bucket only. Settings, Backups shows that account's address, and Test destination shows the exact command when it is missing:

   ```sh
   gcloud storage buckets add-iam-policy-binding gs://acme-signudoc-backups \
     --member=serviceAccount:signudoc@your-project.iam.gserviceaccount.com \
     --role=roles/storage.objectAdmin
   ```

   On Cloud Run nothing else is needed: the app writes as its service account, and no key is stored. Anywhere else the app needs `GOOGLE_SERVICE_ACCOUNT_KEY` for an account with that role.

4. **Choose it** in Settings, Backups (or set `BACKUP_GCS_BUCKET`), test it, and save. The app refuses its own files bucket (`GCS_BUCKET`), because that backup would not survive what it is for.
5. **Schedule the daily call.** Off Vercel nothing calls the backup by itself. Set `CRON_SECRET` (or `RETENTION_JOB_SECRET`) on the app, then have Cloud Scheduler call it once a day with that secret, and a deadline of five minutes:

   ```sh
   gcloud scheduler jobs create http signudoc-backup \
     --schedule="0 8 * * *" --time-zone=UTC \
     --uri="https://<your install>/api/internal/backup" --http-method=POST \
     --headers="Authorization=Bearer <the secret>" --attempt-deadline=300s
   ```

   The Cloud Run service's request timeout must be at least 300 seconds too (it is by default).

### Back up to a second Vercel Blob store

1. **Make the backup store.** In Vercel, go to Storage, Create, Blob, and make a **private** store. Make it in a different Vercel team from the install if you can, so that losing the install's team, or an admin there, does not take the backup with it. Do not connect it to the install's project.
2. **Copy its read-write token.** In the new store, open its settings (or `.env.local` snippet) and copy `BLOB_READ_WRITE_TOKEN`. It starts with `vercel_blob_rw_`.
3. **Give it to the install.** Paste it in Settings, Backups, where it is kept encrypted with a key derived from `BETTER_AUTH_SECRET`. Or, in the install's Vercel project, under Settings, Environment Variables, add `BACKUP_BLOB_READ_WRITE_TOKEN` with that token, for Production, marked Sensitive, and deploy again.
4. **Set `CRON_SECRET`** too, if you have not already (any long random string), so only Vercel's own cron call can start a backup.

On Vercel, Vercel calls `/api/internal/backup` every day at 08:00 UTC (see `vercel.json`). The app refuses a token for its own store, because that backup would not survive what it is for. If `BETTER_AUTH_SECRET` changes, a token saved in Settings can no longer be read; Settings says so, and you paste it again.

### What each run does

- writes the whole database, read as one consistent snapshot, to `database/<time>.ndjson.gz` in the backup, and keeps `BACKUP_KEEP_DAYS` days of them (30 unless you set it, and never fewer than the newest three);
- copies every file that is new or changed since the last run to `files/<same path>`. A run copies for up to four minutes; a first backup of a large install may take a few days to catch up, and each later run only copies what changed;
- keeps the copy of a file that was deleted from the install (by the retention rules, for example) for `BACKUP_KEEP_DAYS` more days, then removes it, so the backup does not hold a document much longer than your retention rules allow.

The format is the same whichever destination it goes to, so a backup made to Blob can be restored into Cloud Storage and the other way round.

To run one by hand, press Run backup now in Settings, or call the address with the secret: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your install>/api/internal/backup`.

Each run is listed in Settings, Backups, and writes a `backup_finished` line to the logs (with the counts), or `backup_failure` if it failed. Settings, Backups shows a warning when the last run failed or no run has finished for two days. With a log drain or a log-based alert, alert on those lines.

**Cost.** The backup holds about as much as the install's store, plus the database copies. On a Vercel Hobby account, a second store in the same account counts against the same free Blob storage, so it halves how much your install can hold for $0. A store in another team has its own allowance. In Cloud Storage you pay for what the bucket holds, its noncurrent versions included, and for each copy written.

**Check it works.** After the first run, look in the backup for `database/` and `files/`. Every few months, do a test restore (below) into a throwaway database, so you know the steps before you need them.

## How long documents are kept

By default an install keeps finished documents forever, until someone deletes them. To delete them after a time instead, an administrator sets a number of days under Settings, Organization, "How long to keep finished documents"; emptying it goes back to forever. See [How long documents are kept](self-hosting.md#how-long-documents-are-kept). The backup follows: a deleted document's copy is removed `BACKUP_KEEP_DAYS` days later.

## Restore

A restore goes into a **new, empty** database and file store, never over a live install. You can then point the install at them, or deploy a new install on them.

You need a computer with Node.js 24 and a copy of this repository at the same version as the install (or newer). For a large Cloud Storage backup, running the same command as a Cloud Run job in the backup's project is faster and needs no key.

1. Make a new, empty database: a new Neon project or branch with no data, or a new Cloud SQL database. Copy its connection string.
2. Make a new place for the restored files: a new private Blob store (copy its read-write token), or a new Cloud Storage bucket the account you restore with can write to. Or, if the install's file store still exists and only the database was lost, use `--skip-files` and skip this.
3. In the repository folder:

   ```sh
   npm ci
   export DATABASE_URL='postgres://…'               # the new, empty database

   # Where the backup is: one of
   export BACKUP_GCS_BUCKET='acme-signudoc-backups'  # (and BACKUP_GCS_PREFIX, if one was used)
   export BACKUP_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_…'

   # Where the files go: one of
   export STORAGE_DRIVER=gcs GCS_BUCKET='acme-signudoc-files-restored'
   export BLOB_READ_WRITE_TOKEN='vercel_blob_rw_…'

   # For a bucket, Google credentials: your own gcloud sign-in will do
   export GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)"

   npm run restore-backup -- --list                  # see which backups there are
   npm run restore-backup                            # restore the newest one
   ```

   `--backup database/<name>` restores an older one instead. The script applies the migrations, loads the database in one transaction (so a failed restore leaves nothing half done), then copies the files back to their own paths. It refuses a database that already has accounts in it, and a backup made by a newer SignuDoc than the copy you are running. If copying the files stops part way (a network error, an expired `GOOGLE_ACCESS_TOKEN`, or you stopped it), run `npm run restore-backup -- --files-only` to finish: it skips the database and every file that is already there. Instead of `GOOGLE_ACCESS_TOKEN` you can set `GOOGLE_SERVICE_ACCOUNT_KEY`; on Google Cloud the metadata server is used.

4. Connect the new database and file store to the install (or a new one) in place of the old ones, keep `BETTER_AUTH_SECRET` the same as before, and deploy. Two-step sign-in keys are encrypted with that secret, and session cookies are signed with it; if it changes, everyone is signed out, and nobody who used two-step sign-in can finish signing in until their setup is cleared (see the note on two-step sign-in in [self-hosting](self-hosting.md#sign-in-security)).
5. Sign in, open a finished document, and check its audit trail and download. Check Settings, Backups too: the restored install has the backup settings it had, so make sure it backs up where you want it to.

What a restore brings back: everything in the database at the time of the backup, and every file as of the last run. A document sent after the last backup is not in it. The hash chains in both audit trails come back exactly as they were, so they still verify.

## In a security review

- **Backup frequency:** daily, at 08:00 UTC on Vercel, or on the deployer's own schedule elsewhere. The database also has its provider's own backups (Neon's history, or Cloud SQL's automated backups and point-in-time recovery).
- **Retention:** `BACKUP_KEEP_DAYS` (30 by default) for database copies and deleted files, plus the backup bucket's noncurrent versions, if versioning is on (the Google Cloud Run setup script deletes them after 30 days).
- **Location and access:** a private Vercel Blob store or Cloud Storage bucket chosen by the deployer, ideally in another Vercel team or Google Cloud project. A Blob store can be read only with its read-write token; a bucket only by the accounts granted access to it (the app's service account needs `roles/storage.objectAdmin` on that bucket alone).
- **Encryption:** Vercel Blob and Cloud Storage encrypt stored data at rest (see their security documentation). The database copy holds the same data as the database, including password hashes and the encrypted two-step sign-in keys, so treat access to the backup like the database password. A Blob token saved in Settings is stored encrypted with a key derived from `BETTER_AUTH_SECRET`.
- **Changes:** every change to the backup settings, and every backup started by hand, is recorded in the site audit trail.
- **Restore testing:** the procedure above, run by the deployer on a schedule they choose.
