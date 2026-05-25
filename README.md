# RentEase — Rental Management System

A full-stack web application for managing rental apartment properties, built during an internship at Infipre, Goa.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Bootstrap 5, EJS |
| Backend | Node.js v24, Express.js |
| Database | MySQL 8.0 |
| PDF Generation | pdfkit |
| Excel Generation | exceljs |
| Email Service | Nodemailer + Gmail SMTP |
| Authentication | express-session |
| Templating | EJS |

---

## Features

### Super Admin
- Add, edit, and delete properties
- Create and manage Property Manager accounts
- Activate and deactivate user accounts
- View system-wide financial reports with date range filter
- Download financial reports as PDF and Excel
- View occupancy report with lease expiry tracking

### Property Manager
- Add, edit, and delete apartments
- Add, edit, and remove tenants
- Record rent payments manually (cash, bank transfer, cheque)
- Generate and download PDF receipts per payment
- Track and update maintenance requests
- View property-specific financial reports
- Download reports as PDF and Excel
- View occupancy report for assigned properties

### Tenant
- View current rent status and due date
- View complete payment history
- Download individual rent receipts as PDF
- Submit maintenance requests with priority levels
- Track maintenance request status and manager notes
- View lease documents

---

## Setup Instructions

### 1. Clone the repository
```bash
git clone https://github.com/ziyadshaikh-cook/RentEase_Rental_MS
cd RentEase_Rental_MS
```

### 2. Install dependencies
```bash
npm install
```

### 3. Create a `.env` file in the project root
```
EMAIL_USER=your_gmail@gmail.com
EMAIL_PASS=your_16_character_app_password
```

> To get an App Password: Go to your Google Account → Security → 2-Step Verification → App Passwords → Create

### 4. Set up the database
- Open XAMPP and start Apache and MySQL
- Open phpMyAdmin at `http://localhost/phpmyadmin`
- Create a new database called `rentease`
- Import the SQL schema to create all tables

### 5. Update database credentials in `app.js` if needed
```javascript
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'rentease'
});
```

### 6. Start the server
```bash
node app.js
```

### 7. Open browser
```
http://localhost:3000
```

---

## Default Login Credentials

| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@rentease.com | admin123 |
| Property Manager | rahul@rentease.com | rahul123 |
| Tenant | anil@gmail.com | anil123 |

> These are for testing only. Change passwords before any real use.

---

## Database Tables

| Table | Purpose |
|-------|---------|
| users | All user accounts with roles |
| properties | Building information |
| apartments | Individual units within properties |
| tenants | Tenant details and lease information |
| payments | Rent payment records |
| maintenance_requests | Maintenance issue tracking |
| notifications | Email notification logs |
| documents | Uploaded lease agreements and notices |

---

## Project Structure

```
RentEase_Rental_MS/
├── app.js                    — Main server, all routes and database queries
├── package.json              — Project dependencies
├── .env                      — Environment variables (not committed to GitHub)
├── .gitignore                — Files excluded from Git
├── views/                    — EJS template pages
│   ├── login.ejs             — Login page
│   ├── admin/                — Super Admin pages
│   │   ├── dashboard.ejs
│   │   ├── properties.ejs
│   │   ├── users.ejs
│   │   ├── reports.ejs
│   │   └── occupancy.ejs
│   ├── manager/              — Property Manager pages
│   │   ├── dashboard.ejs
│   │   ├── apartments.ejs
│   │   ├── tenants.ejs
│   │   ├── rent.ejs
│   │   ├── maintenance.ejs
│   │   ├── reports.ejs
│   │   └── occupancy.ejs
│   ├── tenant/               — Tenant pages
│   │   ├── dashboard.ejs
│   │   ├── payments.ejs
│   │   ├── maintenance.ejs
│   │   └── documents.ejs
│   └── partials/             — Shared components
│       ├── sidebar-admin.ejs
│       ├── sidebar-manager.ejs
│       ├── sidebar-tenant.ejs
│       └── auth-check.ejs
└── public/                   — Static files
    └── css/
        └── style.css         — Main stylesheet
```

---

## User Roles and Access Control

| Feature | Super Admin | Property Manager | Tenant |
|---------|-------------|-----------------|--------|
| View all properties | ✅ | Own only | ❌ |
| Add/Edit/Delete property | ✅ | ❌ | ❌ |
| Create user accounts | ✅ | ❌ | ❌ |
| Manage apartments | ✅ | Own only | ❌ |
| Add/Remove tenants | ❌ | Own only | ❌ |
| Record payments | ❌ | Own only | ❌ |
| Download receipts | ✅ | ✅ | Own only |
| Submit maintenance | ❌ | ❌ | ✅ |
| Update maintenance | ❌ | ✅ | ❌ |
| View financial reports | All | Own only | ❌ |
| Download Excel/PDF | ✅ | ✅ | ❌ |
| View occupancy report | ✅ | Own only | ❌ |

---

## Developer

**Ziyad Shaikh**  
