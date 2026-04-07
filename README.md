# Tenant Logger

A lightweight rental property management app built for families and small landlords. Runs entirely on your own hardware — no cloud subscriptions, no per-seat pricing, no third-party data sharing.

Built with Node.js + Express on the backend and Alpine.js + Tailwind CSS on the frontend. Data is stored in a single JSON file. Designed to be self-hosted on a NAS (e.g. Synology) or any machine that can run Docker.

---

## What problem does it solve?

Managing rental properties across a spreadsheet is tedious and error-prone. Tenant Logger gives families a simple shared app to:

- Know at a glance which tenants have paid rent this month and which haven't
- Get email reminders before leases expire so renewals don't get missed
- Track maintenance work and costs per property
- Store lease documents and work receipts alongside the records
- See a full history of payments, activity, and notifications

It's intentionally simple — no accounts, no roles, just a PIN to log in and a clean mobile-first interface your parents can actually use.

---

## Features

### Properties
- Add and manage multiple rental properties
- Property types: Apartment, House, Shop, Land
- Status tracking: Occupied, Vacant, Under Maintenance
- Attach property documents (scanned agreements, photos)
- Per-property sub-tabs for Tenants, Work Log, Leases, and Payments

### Tenants
- Full tenant profiles: name, phone, email, emergency contact
- Move-in / move-out dates with validation
- Active / inactive status
- Tenant detail view with their lease, payment history, and work log

### Leases
- Link leases to tenants with start date, end date, rent amount, and security deposit
- Attach scanned lease documents (PDF or photo)
- One active lease enforced per tenant
- Lease expiry alerts on the dashboard at 90 / 30 / 7 days and on expiry

### Payments
- Record rent payments with date, amount, month, and payment method (UPI, Cash, Bank Transfer, Cheque)
- Dashboard alerts for any active tenant without a payment recorded for the current month
- Payment history per tenant and per property

### Work Log
- Log maintenance and repair work per property
- Categories: Plumbing, Electrical, Painting, Carpentry, Cleaning, General
- Record contractor name, cost, and attach a receipt photo or PDF

### Email Notifications
- Automated email reminders via any SMTP server (works with Synology Mail Server, Gmail, or any relay)
- **Lease expiry** reminders at 90, 30, and 7 days, plus on expiry — includes rent amount and months remaining
- **Rent overdue** reminders on the 1st and 10th of the month if no payment is recorded — includes expected rent and lease info
- **Missing lease** alerts for active tenants with no active lease
- Notification deduplication — each alert is sent once per threshold period
- Manage recipient email addresses directly in the app Settings (no need to edit config files)
- Full notification history in Settings

### Settings & Data
- Multi-user PIN login (one PIN per family member, named users)
- 30-day signed cookie session
- One-click data backup (downloads full JSON)
- Restore from backup
- Activity log showing who did what and when
- Collapsible notification history and activity log in Settings

### Mobile-Friendly
- Responsive mobile-first design
- Installable as a home screen app on iOS and Android (PWA)
- Custom date picker (Flatpickr) — no native date input overflow issues on mobile
- 16px inputs to prevent auto-zoom on iOS

---

## Installation

### Requirements
- Docker and Docker Compose

### Quick Start

1. **Clone the repo**
   ```bash
   git clone https://github.com/yourusername/tenant-logger.git
   cd tenant-logger
   ```

2. **Configure your PIN**

   Edit `docker-compose.yml` and set the `PIN` environment variable:
   ```yaml
   - PIN=1234
   ```
   For multiple users:
   ```yaml
   - PIN=User1:1234,User2:5678
   ```

3. **Build and run**
   ```bash
   docker-compose up -d
   ```

4. **Open the app**

   Navigate to `http://your-server-ip:3000` in your browser.

---

## Email Notifications (Optional)

Email notifications are optional. If `SMTP_HOST` is not set, the app works fine without them.

### Using a local SMTP server (e.g. Synology Mail Server)

```yaml
environment:
  - SMTP_HOST=192.168.1.100   # LAN IP of your mail server
  - SMTP_PORT=25
  - SMTP_SECURE=false
  - SMTP_USER=myuser           # SMTP auth username
  - SMTP_PASS=mypassword
  - SMTP_FROM=me@example.com
```

### Using Gmail (with App Password)

1. Enable 2-factor authentication on the Gmail account
2. Generate an [App Password](https://myaccount.google.com/apppasswords)

```yaml
environment:
  - SMTP_HOST=smtp.gmail.com
  - SMTP_PORT=587
  - SMTP_SECURE=false
  - SMTP_USER=you@gmail.com
  - SMTP_PASS=your-app-password
  - SMTP_FROM=you@gmail.com
```

### Notification schedule

The default cron `30 3 * * *` runs at 3:30 AM UTC. Adjust for your timezone:
- 9:00 AM IST (UTC+5:30): `30 3 * * *`
- 9:00 AM GMT: `0 9 * * *`
- 9:00 AM EST (UTC-5): `0 14 * * *`

Recipient email addresses can be managed in the app under **Settings → Email Notifications** — no need to restart the container.

---

## Synology NAS Setup

1. Install **Container Manager** from the Synology Package Center
2. Copy the project folder to your NAS (e.g. via File Station to `/docker/tenant-logger`)
3. SSH into the NAS and run:
   ```bash
   cd /volume1/docker/tenant-logger
   docker-compose up -d
   ```
4. Map a different external port if needed (e.g. `3002:3000`) to avoid conflicts with other containers

### Persistent data

All data is stored in `./data/` on the host:
- `data/db.json` — all properties, tenants, leases, payments, work log
- `data/uploads/` — lease documents and work receipts
- `data/activity.log` — activity log

Back up the `data/` folder to keep your data safe.

---

## Project Structure

```
tenant-logger/
├── server.js           # Express server — auth, API, email notifications
├── public/
│   ├── index.html      # Single-page app (Alpine.js + Tailwind CSS)
│   ├── icon.svg        # App icon
│   ├── icon-192.png    # PWA icon (192×192)
│   ├── icon-512.png    # PWA icon (512×512)
│   └── manifest.json   # PWA manifest
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Frontend | Alpine.js, Tailwind CSS (CDN) |
| Date picker | Flatpickr |
| Email | Nodemailer |
| Scheduling | node-cron |
| Storage | JSON file (`data/db.json`) |
| Auth | PIN + signed cookie (30-day session) |
| Deployment | Docker |

---

## License

MIT
