const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const session = require('express-session');

require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});


const app = express();

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files and body parser
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session setup
app.use(session({
    secret: 'rentease-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Database connection
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'rentease'
});

db.connect((err) => {
    if (err) {
        console.log('Database connection failed:', err.message);
    } else {
        console.log('Connected to MySQL database');
    }
});

// Make db available everywhere
app.use((req, res, next) => {
    req.db = db;
    next();
});

// No cache middleware — prevents back button after logout
const noCache = (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, private, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '-1');
    res.set('Surrogate-Control', 'no-store');
    next();
};

// Auth middleware — blocks access without login
const requireLogin = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/');
    }
    next();
};

// Role middleware
const requireAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'super_admin') {
        res.set('Cache-Control', 'no-store');
        return res.redirect('/');
    }
    next();
};

const requireManager = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'property_manager') {
        res.set('Cache-Control', 'no-store');
        return res.redirect('/');
    }
    next();
};

const requireTenant = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'tenant') {
        res.set('Cache-Control', 'no-store');
        return res.redirect('/');
    }
    next();
};

// ==================
// PUBLIC ROUTES
// ==================
app.get('/', noCache, (req, res) => {
    if (req.session.user) {
        const role = req.session.user.role;
        if (role === 'super_admin') return res.redirect('/admin/dashboard');
        if (role === 'property_manager') return res.redirect('/manager/dashboard');
        if (role === 'tenant') return res.redirect('/tenant/dashboard');
    }
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;

    const query = 'SELECT * FROM users WHERE email = ? AND is_active = 1';
    db.query(query, [email], (err, results) => {
        if (err) {
            return res.render('login', { error: 'Something went wrong. Please try again.' });
        }

        if (results.length === 0) {
            return res.render('login', { error: 'Invalid email or password.' });
        }

        const user = results[0];

        // Plain text password check for now
        // We will add bcrypt hashing later
        if (password !== user.password) {
            return res.render('login', { error: 'Invalid email or password.' });
        }

        // Save user in session
        req.session.user = {
            id: user.user_id,
            name: user.name,
            email: user.email,
            role: user.role
        };

        // Redirect based on role
        if (user.role === 'super_admin') return res.redirect('/admin/dashboard');
        if (user.role === 'property_manager') return res.redirect('/manager/dashboard');
        if (user.role === 'tenant') return res.redirect('/tenant/dashboard');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

// ==================
// SUPER ADMIN ROUTES
// ==================
app.get('/admin/dashboard', noCache, requireAdmin, (req, res) => {
    const queries = {
        totalProperties: 'SELECT COUNT(*) AS count FROM properties',
        totalApartments: 'SELECT COUNT(*) AS count FROM apartments',
        totalTenants: 'SELECT COUNT(*) AS count FROM tenants',
        rentCollected: 'SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE MONTH(payment_date) = MONTH(CURDATE()) AND YEAR(payment_date) = YEAR(CURDATE())',
        pendingDues: `
            SELECT u.name, p.name AS property_name, a.apt_number, 
                   a.rent_amount, t.tenant_id,
                   CONCAT('May 1, ', YEAR(CURDATE())) AS due_date
            FROM tenants t
            JOIN users u ON t.user_id = u.user_id
            JOIN apartments a ON t.apartment_id = a.apartment_id
            JOIN properties p ON a.property_id = p.property_id
            WHERE t.tenant_id NOT IN (
                SELECT tenant_id FROM payments 
                WHERE MONTH(payment_date) = MONTH(CURDATE()) 
                AND YEAR(payment_date) = YEAR(CURDATE())
            )
            LIMIT 5`,
        properties: `
            SELECT p.*, u.name AS manager_name,
                   COUNT(a.apartment_id) AS total_apts,
                   SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied_apts
            FROM properties p
            LEFT JOIN users u ON p.manager_id = u.user_id
            LEFT JOIN apartments a ON p.property_id = a.property_id
            GROUP BY p.property_id
            LIMIT 5`
    };

    const results = {};

    db.query(queries.totalProperties, (err, rows) => {
        results.totalProperties = err ? 0 : rows[0].count;

        db.query(queries.totalApartments, (err, rows) => {
            results.totalApartments = err ? 0 : rows[0].count;

            db.query(queries.totalTenants, (err, rows) => {
                results.totalTenants = err ? 0 : rows[0].count;

                db.query(queries.rentCollected, (err, rows) => {
                    results.rentCollected = err ? 0 : rows[0].total;

                    db.query(queries.pendingDues, (err, rows) => {
                        results.pendingDues = err ? [] : rows;

                        db.query(queries.properties, (err, rows) => {
                            results.properties = err ? [] : rows;

                            res.render('admin/dashboard', {
                                active: 'dashboard',
                                user: req.session.user,
                                data: results
                            });
                        });
                    });
                });
            });
        });
    });
});

app.get('/admin/properties', noCache, requireAdmin, (req, res) => {
    const query = `
        SELECT p.*, u.name AS manager_name
        FROM properties p
        LEFT JOIN users u ON p.manager_id = u.user_id
        ORDER BY p.property_id
    `;
    const managersQuery = `SELECT user_id, name FROM users WHERE role = 'property_manager' AND is_active = 1`;

    db.query(query, (err, properties) => {
        db.query(managersQuery, (err2, managers) => {
            res.render('admin/properties', {
                active: 'properties',
                user: req.session.user,
                properties: err ? [] : properties,
                managers: err2 ? [] : managers
            });
        });
    });
});

app.get('/admin/users', noCache, requireAdmin, (req, res) => {
    const managersQuery = `
        SELECT u.*, p.name AS property_name 
        FROM users u
        LEFT JOIN properties p ON p.manager_id = u.user_id
        WHERE u.role = 'property_manager'
        ORDER BY u.user_id
    `;
    const tenantsQuery = `
        SELECT u.*, 
               p.name AS property_name, 
               a.apt_number
        FROM users u
        JOIN tenants t ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        WHERE u.role = 'tenant'
        ORDER BY u.user_id
    `;
    const propertiesQuery = `SELECT property_id, name FROM properties ORDER BY name`;

    db.query(managersQuery, (err, managers) => {
        db.query(tenantsQuery, (err2, tenants) => {
            db.query(propertiesQuery, (err3, properties) => {
                res.render('admin/users', {
                    active: 'users',
                    user: req.session.user,
                    managers: err ? [] : managers,
                    tenants: err2 ? [] : tenants,
                    properties: err3 ? [] : properties
                });
            });
        });
    });
});

app.get('/admin/reports', noCache, requireAdmin, (req, res) => {
    const today = new Date();
    const firstDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDayDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const lastDay = `${lastDayDate.getFullYear()}-${String(lastDayDate.getMonth() + 1).padStart(2, '0')}-${String(lastDayDate.getDate()).padStart(2, '0')}`;

    const fromDate = req.query.from_date || firstDay;
    const toDate = req.query.to_date || lastDay;

    const summaryQuery = `
        SELECT 
            (SELECT COUNT(*) FROM properties) AS total_properties,
            (SELECT COUNT(*) FROM apartments) AS total_apartments,
            (SELECT COUNT(*) FROM apartments WHERE status = 'occupied') AS occupied_apartments,
            (SELECT COUNT(*) FROM tenants) AS total_tenants,
            (SELECT COALESCE(SUM(amount), 0) FROM payments 
             WHERE payment_date BETWEEN ? AND ?) AS rent_collected
    `;

    const propertyBreakdownQuery = `
        SELECT p.name,
               COUNT(a.apartment_id) AS total_units,
               SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
               COALESCE(SUM(CASE WHEN a.status = 'occupied' THEN a.rent_amount ELSE 0 END), 0) AS expected_rent,
               COALESCE((
                   SELECT SUM(pay.amount)
                   FROM payments pay
                   JOIN tenants t ON pay.tenant_id = t.tenant_id
                   JOIN apartments apt ON t.apartment_id = apt.apartment_id
                   WHERE apt.property_id = p.property_id
                   AND pay.payment_date BETWEEN ? AND ?
               ), 0) AS collected
        FROM properties p
        LEFT JOIN apartments a ON p.property_id = a.property_id
        GROUP BY p.property_id
    `;

    db.query(summaryQuery, [fromDate, toDate], (err, summaryRows) => {
        const summary = err ? {} : summaryRows[0];

        db.query(propertyBreakdownQuery, [fromDate, toDate], (err2, breakdown) => {
            res.render('admin/reports', {
                active: 'reports',
                user: req.session.user,
                summary: summary,
                breakdown: err2 ? [] : breakdown,
                fromDate: fromDate,
                toDate: toDate
            });
        });
    });
});

// ==================
// MANAGER ROUTES
// ==================
app.get('/manager/dashboard', noCache, requireManager, (req, res) => {
    const managerId = req.session.user.id;
    const month = new Date().getMonth() + 1;
    const year = new Date().getFullYear();

    const statsQuery = `
        SELECT 
            (SELECT COUNT(*) FROM properties WHERE manager_id = ?) AS total_properties,
            (SELECT COUNT(*) FROM apartments a 
             JOIN properties p ON a.property_id = p.property_id 
             WHERE p.manager_id = ?) AS total_apartments,
            (SELECT COUNT(*) FROM apartments a 
             JOIN properties p ON a.property_id = p.property_id 
             WHERE p.manager_id = ? AND a.status = 'occupied') AS occupied_apartments,
            (SELECT COUNT(*) FROM apartments a 
             JOIN properties p ON a.property_id = p.property_id 
             WHERE p.manager_id = ? AND a.status = 'vacant') AS vacant_apartments,
            (SELECT COALESCE(SUM(pay.amount), 0) 
             FROM payments pay
             JOIN tenants t ON pay.tenant_id = t.tenant_id
             JOIN apartments a ON t.apartment_id = a.apartment_id
             JOIN properties p ON a.property_id = p.property_id
             WHERE p.manager_id = ? 
             AND MONTH(pay.payment_date) = ? 
             AND YEAR(pay.payment_date) = ?) AS rent_collected,
            (SELECT COUNT(*) FROM maintenance_requests mr
             JOIN tenants t ON mr.tenant_id = t.tenant_id
             JOIN apartments a ON t.apartment_id = a.apartment_id
             JOIN properties p ON a.property_id = p.property_id
             WHERE p.manager_id = ? AND mr.status = 'open') AS open_maintenance
    `;

    const rentStatusQuery = `
        SELECT u.name, p.name AS property_name, a.apt_number,
               a.rent_amount,
               pay.amount AS paid_amount,
               pay.payment_date,
               pay.payment_method,
               CASE WHEN pay.payment_id IS NOT NULL THEN 'Paid'
                    WHEN CURDATE() > DATE_FORMAT(CURDATE(), '%Y-%m-01') + INTERVAL 3 DAY THEN 'Overdue'
                    ELSE 'Pending'
               END AS status
        FROM tenants t
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        LEFT JOIN payments pay ON pay.tenant_id = t.tenant_id
            AND MONTH(pay.payment_date) = ? AND YEAR(pay.payment_date) = ?
        WHERE p.manager_id = ?
        LIMIT 5
    `;

    const maintenanceQuery = `
        SELECT u.name, p.name AS property_name, a.apt_number,
               mr.title, mr.priority, mr.status, mr.created_at
        FROM maintenance_requests mr
        JOIN tenants t ON mr.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ?
        ORDER BY mr.created_at DESC
        LIMIT 5
    `;

    db.query(statsQuery, [managerId, managerId, managerId, managerId, managerId, month, year, managerId], (err, statsRows) => {
        const stats = err ? {} : statsRows[0];

        db.query(rentStatusQuery, [month, year, managerId], (err2, rentRows) => {
            db.query(maintenanceQuery, [managerId], (err3, maintenanceRows) => {
                res.render('manager/dashboard', {
                    active: 'dashboard',
                    user: req.session.user,
                    stats: stats,
                    rentStatus: err2 ? [] : rentRows,
                    maintenance: err3 ? [] : maintenanceRows
                });
            });
        });
    });
});

app.get('/manager/apartments', noCache, requireManager, (req, res) => {
    const managerId = req.session.user.id;

    const apartmentsQuery = `
        SELECT a.*, p.name AS property_name,
               u.name AS tenant_name
        FROM apartments a
        JOIN properties p ON a.property_id = p.property_id
        LEFT JOIN tenants t ON t.apartment_id = a.apartment_id
        LEFT JOIN users u ON t.user_id = u.user_id
        WHERE p.manager_id = ?
        ORDER BY p.property_id, a.apt_number
    `;

    const propertiesQuery = `
        SELECT property_id, name FROM properties 
        WHERE manager_id = ?
    `;

    db.query(apartmentsQuery, [managerId], (err, apartments) => {
        db.query(propertiesQuery, [managerId], (err2, properties) => {
            res.render('manager/apartments', {
                active: 'apartments',
                user: req.session.user,
                apartments: err ? [] : apartments,
                properties: err2 ? [] : properties
            });
        });
    });
});

app.get('/manager/tenants', noCache, requireManager, (req, res) => {
    const managerId = req.session.user.id;

    const tenantsQuery = `
        SELECT u.name, u.email, u.phone, u.is_active,
               a.apt_number, p.name AS property_name,
               t.lease_start, t.lease_end, t.deposit_amount, t.tenant_id
        FROM tenants t
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ?
        ORDER BY t.tenant_id
    `;

    const vacantApartmentsQuery = `
        SELECT a.apartment_id, a.apt_number, p.name AS property_name
        FROM apartments a
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ? AND a.status = 'vacant'
    `;

    db.query(tenantsQuery, [managerId], (err, tenants) => {
        db.query(vacantApartmentsQuery, [managerId], (err2, vacantApts) => {
            res.render('manager/tenants', {
                active: 'tenants',
                user: req.session.user,
                tenants: err ? [] : tenants,
                vacantApts: err2 ? [] : vacantApts
            });
        });
    });
});

app.get('/manager/rent', noCache, requireManager, (req, res) => {
    const managerId = req.session.user.id;
    const month = new Date().getMonth() + 1;
    const year = new Date().getFullYear();

    const summaryQuery = `
        SELECT 
            COALESCE(SUM(a.rent_amount), 0) AS total_expected,
            COALESCE((
                SELECT SUM(pay.amount) 
                FROM payments pay
                JOIN tenants t ON pay.tenant_id = t.tenant_id
                JOIN apartments a2 ON t.apartment_id = a2.apartment_id
                JOIN properties p2 ON a2.property_id = p2.property_id
                WHERE p2.manager_id = ?
                AND MONTH(pay.payment_date) = ? 
                AND YEAR(pay.payment_date) = ?
            ), 0) AS total_collected
        FROM apartments a
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ? AND a.status = 'occupied'
    `;

    const rentStatusQuery = `
        SELECT u.name, p.name AS property_name, a.apt_number,
               a.rent_amount, t.tenant_id,
               pay.payment_id, pay.amount AS paid_amount,
               pay.payment_date, pay.payment_method,
               pay.receipt_number,
               CASE 
                   WHEN pay.payment_id IS NOT NULL THEN 'Paid'
                   WHEN CURDATE() > LAST_DAY(CURDATE() - INTERVAL 1 MONTH) + INTERVAL 3 DAY THEN 'Overdue'
                   ELSE 'Pending'
               END AS status
        FROM tenants t
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        LEFT JOIN payments pay ON pay.tenant_id = t.tenant_id
            AND MONTH(pay.payment_date) = ? 
            AND YEAR(pay.payment_date) = ?
        WHERE p.manager_id = ?
        ORDER BY status DESC, u.name
    `;

    const tenantsQuery = `
        SELECT t.tenant_id, u.name, a.apt_number, p.name AS property_name, a.rent_amount
        FROM tenants t
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ?
    `;

    db.query(summaryQuery, [managerId, month, year, managerId], (err, summaryRows) => {
        const summary = err ? {} : summaryRows[0];

        db.query(rentStatusQuery, [month, year, managerId], (err2, rentRows) => {
            db.query(tenantsQuery, [managerId], (err3, tenantRows) => {
                res.render('manager/rent', {
                    active: 'rent',
                    user: req.session.user,
                    summary: summary,
                    rentStatus: err2 ? [] : rentRows,
                    tenants: err3 ? [] : tenantRows,
                    month: month,
                    year: year
                });
            });
        });
    });
});

app.get('/manager/maintenance', noCache, requireManager, (req, res) => {
    const managerId = req.session.user.id;

    const statsQuery = `
        SELECT 
            SUM(CASE WHEN mr.status = 'open' THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN mr.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
            SUM(CASE WHEN mr.status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count
        FROM maintenance_requests mr
        JOIN tenants t ON mr.tenant_id = t.tenant_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ?
    `;

    const requestsQuery = `
        SELECT mr.*, u.name AS tenant_name, 
               a.apt_number, p.name AS property_name
        FROM maintenance_requests mr
        JOIN tenants t ON mr.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ?
        ORDER BY mr.created_at DESC
    `;

    db.query(statsQuery, [managerId], (err, statsRows) => {
        const stats = err ? {} : statsRows[0];

        db.query(requestsQuery, [managerId], (err2, requests) => {
            res.render('manager/maintenance', {
                active: 'maintenance',
                user: req.session.user,
                stats: stats,
                requests: err2 ? [] : requests
            });
        });
    });
});

app.get('/manager/reports', noCache, requireManager, (req, res) => {
    const managerId = req.session.user.id;

    const today = new Date();
    const firstDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDayDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const lastDay = `${lastDayDate.getFullYear()}-${String(lastDayDate.getMonth() + 1).padStart(2, '0')}-${String(lastDayDate.getDate()).padStart(2, '0')}`;

    const fromDate = req.query.from_date || firstDay;
    const toDate = req.query.to_date || lastDay;

const summaryQuery = `
    SELECT 
        COUNT(DISTINCT a.apartment_id) AS total_apartments,
        SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
        SUM(CASE WHEN a.status = 'vacant' THEN 1 ELSE 0 END) AS vacant,
        COALESCE((
            SELECT SUM(pay.amount)
            FROM payments pay
            JOIN tenants t2 ON pay.tenant_id = t2.tenant_id
            JOIN apartments a2 ON t2.apartment_id = a2.apartment_id
            JOIN properties p2 ON a2.property_id = p2.property_id
            WHERE p2.manager_id = ?
            AND pay.payment_date BETWEEN ? AND ?
        ), 0) AS total_collected,
        COALESCE((
            SELECT SUM(a3.rent_amount)
            FROM apartments a3
            JOIN properties p3 ON a3.property_id = p3.property_id
            WHERE p3.manager_id = ? AND a3.status = 'occupied'
        ), 0) AS total_expected
    FROM apartments a
    JOIN properties p ON a.property_id = p.property_id
    WHERE p.manager_id = ?
`;

    const breakdownQuery = `
        SELECT p.name,
               COUNT(a.apartment_id) AS total_units,
               SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
               COALESCE(SUM(CASE WHEN a.status = 'occupied' THEN a.rent_amount ELSE 0 END), 0) AS expected_rent,
               COALESCE((
                   SELECT SUM(pay.amount)
                   FROM payments pay
                   JOIN tenants t ON pay.tenant_id = t.tenant_id
                   JOIN apartments a2 ON t.apartment_id = a2.apartment_id
                   WHERE a2.property_id = p.property_id
                   AND pay.payment_date BETWEEN ? AND ?
               ), 0) AS collected
        FROM properties p
        LEFT JOIN apartments a ON p.property_id = a.property_id
        WHERE p.manager_id = ?
        GROUP BY p.property_id
    `;

    const tenantPaymentsQuery = `
        SELECT u.name, p.name AS property_name, a.apt_number,
               a.rent_amount,
               pay.amount AS paid_amount,
               pay.payment_date,
               pay.payment_method,
               CASE WHEN pay.payment_id IS NOT NULL THEN 'Paid' ELSE 'Pending' END AS status
        FROM tenants t
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        LEFT JOIN payments pay ON pay.tenant_id = t.tenant_id
            AND pay.payment_date BETWEEN ? AND ?
        WHERE p.manager_id = ?
        ORDER BY status, u.name
    `;

    db.query(summaryQuery, [managerId, fromDate, toDate, managerId, managerId], (err, summaryRows) => {
        const summary = err ? {} : summaryRows[0];

        db.query(breakdownQuery, [fromDate, toDate, managerId], (err2, breakdown) => {
            db.query(tenantPaymentsQuery, [fromDate, toDate, managerId], (err3, tenantPayments) => {
                res.render('manager/reports', {
                    active: 'reports',
                    user: req.session.user,
                    summary: summary,
                    breakdown: err2 ? [] : breakdown,
                    tenantPayments: err3 ? [] : tenantPayments,
                    fromDate: fromDate,
                    toDate: toDate
                });
            });
        });
    });
});

// ==================
// TENANT ROUTES
// ==================
app.get('/tenant/dashboard', noCache, requireTenant, (req, res) => {
    const userId = req.session.user.id;

    const tenantQuery = `
        SELECT t.*, a.apt_number, a.rent_amount, a.floor, a.bedrooms,
               p.name AS property_name, p.city, p.state, p.pincode,
               u2.name AS manager_name
        FROM tenants t
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        JOIN users u2 ON p.manager_id = u2.user_id
        WHERE t.user_id = ?
    `;

    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const paymentStatusQuery = `
        SELECT * FROM payments 
        WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE user_id = ?)
        AND MONTH(payment_date) = ? AND YEAR(payment_date) = ?
    `;

    const recentPaymentsQuery = `
        SELECT * FROM payments 
        WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE user_id = ?)
        ORDER BY payment_date DESC
        LIMIT 3
    `;

    const openRequestsQuery = `
        SELECT COUNT(*) AS count FROM maintenance_requests
        WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE user_id = ?)
        AND status != 'resolved'
    `;

    db.query(tenantQuery, [userId], (err, tenantRows) => {
        const tenant = err ? {} : tenantRows[0];

        db.query(paymentStatusQuery, [userId, currentMonth, currentYear], (err2, paymentRows) => {
            const currentPayment = paymentRows && paymentRows.length > 0 ? paymentRows[0] : null;

            db.query(recentPaymentsQuery, [userId], (err3, recentPayments) => {
                db.query(openRequestsQuery, [userId], (err4, requestRows) => {
                    const openRequests = err4 ? 0 : requestRows[0].count;

                    res.render('tenant/dashboard', {
                        active: 'dashboard',
                        user: req.session.user,
                        tenant: tenant,
                        currentPayment: currentPayment,
                        recentPayments: err3 ? [] : recentPayments,
                        openRequests: openRequests,
                        currentMonth: currentMonth,
                        currentYear: currentYear
                    });
                });
            });
        });
    });
});

app.get('/tenant/payments', noCache, requireTenant, (req, res) => {
    const userId = req.session.user.id;

    const paymentsQuery = `
        SELECT pay.* FROM payments pay
        JOIN tenants t ON pay.tenant_id = t.tenant_id
        WHERE t.user_id = ?
        ORDER BY pay.payment_date DESC
    `;

    const statsQuery = `
        SELECT 
            COUNT(*) AS total_payments,
            COALESCE(SUM(amount), 0) AS total_paid
        FROM payments
        WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE user_id = ?)
    `;

    db.query(paymentsQuery, [userId], (err, payments) => {
        db.query(statsQuery, [userId], (err2, statsRows) => {
            const stats = err2 ? {} : statsRows[0];
            res.render('tenant/payments', {
                active: 'payments',
                user: req.session.user,
                payments: err ? [] : payments,
                stats: stats
            });
        });
    });
});

app.get('/tenant/maintenance', noCache, requireTenant, (req, res) => {
    const userId = req.session.user.id;

    const statsQuery = `
        SELECT 
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
            SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count
        FROM maintenance_requests
        WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE user_id = ?)
    `;

    const requestsQuery = `
        SELECT * FROM maintenance_requests
        WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE user_id = ?)
        ORDER BY created_at DESC
    `;

    db.query(statsQuery, [userId], (err, statsRows) => {
        const stats = err ? {} : statsRows[0];

        db.query(requestsQuery, [userId], (err2, requests) => {
            res.render('tenant/maintenance', {
                active: 'maintenance',
                user: req.session.user,
                stats: stats,
                requests: err2 ? [] : requests
            });
        });
    });
});

app.get('/tenant/documents', noCache, requireTenant, (req, res) => {
    const userId = req.session.user.id;

    const documentsQuery = `
        SELECT d.* FROM documents d
        JOIN tenants t ON d.tenant_id = t.tenant_id
        WHERE t.user_id = ?
        ORDER BY d.uploaded_at DESC
    `;

    db.query(documentsQuery, [userId], (err, documents) => {
        res.render('tenant/documents', {
            active: 'documents',
            user: req.session.user,
            documents: err ? [] : documents
        });
    });
});

app.get('/check-session', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/manager/maintenance/update', noCache, requireManager, (req, res) => {
    const { request_id, status, manager_notes } = req.body;

    const query = `
        UPDATE maintenance_requests 
        SET status = ?, manager_notes = ?, updated_at = NOW()
        WHERE request_id = ?
    `;

    db.query(query, [status, manager_notes, request_id], (err) => {
        if (err) {
            console.log('Error updating maintenance request:', err);
        }
        res.redirect('/manager/maintenance');
    });
});

app.post('/manager/rent/record', noCache, requireManager, (req, res) => {
    const { tenant_id, amount, payment_date, payment_method, month, year } = req.body;

    const today = new Date();
    const receiptNumber = `RCP-${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}-${String(Math.floor(Math.random()*9000)+1000)}`;

    const query = `
        INSERT INTO payments (tenant_id, amount, payment_date, payment_method, receipt_number, month, year)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [tenant_id, amount, payment_date, payment_method.toLowerCase().replace(' ', '_'), receiptNumber, month, year], (err) => {
        if (err) {
            console.log('Payment error:', err);
        }
        res.redirect('/manager/rent');
    });
});

app.post('/admin/properties/add', noCache, requireAdmin, (req, res) => {
    const { name, address, city, state, pincode, total_floors, total_apartments, manager_id, property_type } = req.body;

    const query = `
        INSERT INTO properties (name, address, city, state, pincode, total_floors, total_apartments, manager_id, property_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [name, address, city, state, pincode, total_floors, total_apartments, manager_id || null, property_type || 'residential'], (err) => {
        if (err) {
            console.log('Add property error:', err);
        }
        res.redirect('/admin/properties');
    });
});

app.post('/admin/users/add', noCache, requireAdmin, (req, res) => {
    const { name, email, phone, role, property_id, password } = req.body;

    const checkQuery = 'SELECT * FROM users WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (results && results.length > 0) {
            return res.redirect('/admin/users');
        }

        const insertQuery = `
            INSERT INTO users (name, email, password, role, phone, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
        `;

        db.query(insertQuery, [name, email, password, role, phone], (err, result) => {
            if (err) {
                console.log('Add user error:', err);
                return res.redirect('/admin/users');
            }

            const newUserId = result.insertId;

            // Send welcome email
            const mailOptions = {
                from: `"RentEase System" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: 'Welcome to RentEase — Your Login Credentials',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
                        <h2 style="color: #2C3E50;">Welcome to RentEase</h2>
                        <p>Hello <strong>${name}</strong>,</p>
                        <p>Your account has been created. Here are your login credentials:</p>
                        <div style="background: #f5f6fa; padding: 16px; border-radius: 8px; margin: 20px 0;">
                            <p><strong>Email:</strong> ${email}</p>
                            <p><strong>Password:</strong> ${password}</p>
                            <p><strong>Role:</strong> ${role.replace('_', ' ').toUpperCase()}</p>
                        </div>
                        <p>Login at: <a href="http://localhost:3000">http://localhost:3000</a></p>
                        <p style="color: #e74c3c;">Please keep your credentials safe.</p>
                        <hr>
                        <p style="color: #7f8c8d; font-size: 12px;">This is an automated email from RentEase.</p>
                    </div>
                `
            };

            transporter.sendMail(mailOptions, (emailErr, info) => {
                if (emailErr) {
                    console.log('Email error:', emailErr.message);
                } else {
                    console.log('Welcome email sent to:', email);
                }

                if (role === 'property_manager' && property_id) {
                    const updateProperty = `UPDATE properties SET manager_id = ? WHERE property_id = ?`;
                    db.query(updateProperty, [newUserId, property_id], (err2) => {
                        res.redirect('/admin/users');
                    });
                } else {
                    res.redirect('/admin/users');
                }
            });
        });
    });
});

app.post('/manager/apartments/add', noCache, requireManager, (req, res) => {
    const { property_id, apt_number, floor, bedrooms, rent_amount } = req.body;

    const checkQuery = `SELECT * FROM apartments WHERE property_id = ? AND apt_number = ?`;
    db.query(checkQuery, [property_id, apt_number], (err, results) => {
        if (results && results.length > 0) {
            return res.redirect('/manager/apartments');
        }

        const insertQuery = `
            INSERT INTO apartments (property_id, apt_number, floor, rent_amount, bedrooms, status)
            VALUES (?, ?, ?, ?, ?, 'vacant')
        `;

        db.query(insertQuery, [property_id, apt_number, floor, rent_amount, bedrooms], (err) => {
            if (err) {
                console.log('Add apartment error:', err);
            }
            res.redirect('/manager/apartments');
        });
    });
});

app.post('/manager/tenants/add', noCache, requireManager, (req, res) => {
    const { name, email, phone, id_proof, apartment_id, lease_start, lease_end, deposit_amount, password } = req.body;

    const checkQuery = 'SELECT * FROM users WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (results && results.length > 0) {
            return res.redirect('/manager/tenants');
        }

        const insertUserQuery = `
            INSERT INTO users (name, email, password, role, phone, is_active)
            VALUES (?, ?, ?, 'tenant', ?, 1)
        `;

        db.query(insertUserQuery, [name, email, password, phone], (err, userResult) => {
            if (err) {
                console.log('Add tenant user error:', err);
                return res.redirect('/manager/tenants');
            }

            const newUserId = userResult.insertId;

            const insertTenantQuery = `
                INSERT INTO tenants (user_id, apartment_id, lease_start, lease_end, deposit_amount, id_proof)
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            db.query(insertTenantQuery, [newUserId, apartment_id, lease_start, lease_end, deposit_amount, id_proof], (err2) => {
                if (err2) {
                    console.log('Add tenant record error:', err2);
                    return res.redirect('/manager/tenants');
                }

                const updateApartmentQuery = `UPDATE apartments SET status = 'occupied' WHERE apartment_id = ?`;
                db.query(updateApartmentQuery, [apartment_id], (err3) => {
                    if (err3) console.log('Update apartment error:', err3);

                    // Send welcome email to tenant
                    const mailOptions = {
                        from: `"RentEase System" <${process.env.EMAIL_USER}>`,
                        to: email,
                        subject: 'Welcome to RentEase — Your Tenant Login Credentials',
                        html: `
                            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
                                <h2 style="color: #2C3E50;">Welcome to RentEase</h2>
                                <p>Hello <strong>${name}</strong>,</p>
                                <p>Your tenant account has been created. Here are your login credentials:</p>
                                <div style="background: #f5f6fa; padding: 16px; border-radius: 8px; margin: 20px 0;">
                                    <p><strong>Email:</strong> ${email}</p>
                                    <p><strong>Password:</strong> ${password}</p>
                                    <p><strong>Role:</strong> TENANT</p>
                                </div>
                                <p>Login at: <a href="http://localhost:3000">http://localhost:3000</a></p>
                                <p style="color: #e74c3c;">Please keep your credentials safe.</p>
                                <hr>
                                <p style="color: #7f8c8d; font-size: 12px;">This is an automated email from RentEase.</p>
                            </div>
                        `
                    };

                    transporter.sendMail(mailOptions, (emailErr, info) => {
                        if (emailErr) {
                            console.log('Tenant email error:', emailErr.message);
                        } else {
                            console.log('Welcome email sent to tenant:', email);
                        }
                        res.redirect('/manager/tenants');
                    });
                });
            });
        });
    });
});

app.post('/admin/users/deactivate', noCache, requireAdmin, (req, res) => {
    const { user_id } = req.body;

    const query = `UPDATE users SET is_active = 0 WHERE user_id = ?`;
    db.query(query, [user_id], (err) => {
        if (err) {
            console.log('Deactivate user error:', err);
        }
        res.redirect('/admin/users');
    });
});

app.post('/tenant/maintenance/add', noCache, requireTenant, (req, res) => {
    const { title, description, priority } = req.body;
    const userId = req.session.user.id;

    const tenantQuery = `SELECT tenant_id FROM tenants WHERE user_id = ?`;
    db.query(tenantQuery, [userId], (err, results) => {
        if (err || results.length === 0) {
            return res.redirect('/tenant/maintenance');
        }

        const tenantId = results[0].tenant_id;

        const insertQuery = `
            INSERT INTO maintenance_requests (tenant_id, title, description, priority, status)
            VALUES (?, ?, ?, ?, 'open')
        `;

        db.query(insertQuery, [tenantId, title, description, priority], (err2) => {
            if (err2) {
                console.log('Maintenance request error:', err2);
            }
            res.redirect('/tenant/maintenance');
        });
    });
});

app.post('/admin/properties/edit', noCache, requireAdmin, (req, res) => {
    const { property_id, name, address, city, state, pincode, total_floors, total_apartments, manager_id, property_type } = req.body;

    const query = `
        UPDATE properties 
        SET name = ?, address = ?, city = ?, state = ?, pincode = ?, 
            total_floors = ?, total_apartments = ?, manager_id = ?, property_type = ?
        WHERE property_id = ?
    `;

    db.query(query, [name, address, city, state, pincode, total_floors, total_apartments, manager_id || null, property_type, property_id], (err) => {
        if (err) {
            console.log('Edit property error:', err);
        }
        res.redirect('/admin/properties');
    });
});

app.post('/admin/properties/delete', noCache, requireAdmin, (req, res) => {
    const { property_id } = req.body;

    // Check if property has active tenants
    const checkQuery = `
        SELECT COUNT(*) AS count FROM tenants t
        JOIN apartments a ON t.apartment_id = a.apartment_id
        WHERE a.property_id = ?
    `;

    db.query(checkQuery, [property_id], (err, results) => {
        if (results[0].count > 0) {
            return res.redirect('/admin/properties');
        }

        const deleteQuery = `DELETE FROM properties WHERE property_id = ?`;
        db.query(deleteQuery, [property_id], (err2) => {
            if (err2) {
                console.log('Delete property error:', err2);
            }
            res.redirect('/admin/properties');
        });
    });
});

app.post('/manager/apartments/edit', noCache, requireManager, (req, res) => {
    const { apartment_id, apt_number, floor, bedrooms, rent_amount } = req.body;

    const query = `
        UPDATE apartments 
        SET apt_number = ?, floor = ?, bedrooms = ?, rent_amount = ?
        WHERE apartment_id = ?
    `;

    db.query(query, [apt_number, floor, bedrooms, rent_amount, apartment_id], (err) => {
        if (err) {
            console.log('Edit apartment error:', err);
        }
        res.redirect('/manager/apartments');
    });
});

app.post('/manager/apartments/delete', noCache, requireManager, (req, res) => {
    const { apartment_id } = req.body;

    const checkQuery = `SELECT * FROM tenants WHERE apartment_id = ?`;
    db.query(checkQuery, [apartment_id], (err, results) => {
        if (results && results.length > 0) {
            return res.redirect('/manager/apartments');
        }

        const deleteQuery = `DELETE FROM apartments WHERE apartment_id = ?`;
        db.query(deleteQuery, [apartment_id], (err2) => {
            if (err2) {
                console.log('Delete apartment error:', err2);
            }
            res.redirect('/manager/apartments');
        });
    });
});

app.post('/manager/tenants/edit', noCache, requireManager, (req, res) => {
    const { tenant_id, name, phone, lease_start, lease_end, deposit_amount, id_proof } = req.body;

    const getTenantQuery = `SELECT user_id FROM tenants WHERE tenant_id = ?`;
    db.query(getTenantQuery, [tenant_id], (err, results) => {
        if (err || results.length === 0) return res.redirect('/manager/tenants');

        const userId = results[0].user_id;

        const updateUserQuery = `UPDATE users SET name = ?, phone = ? WHERE user_id = ?`;
        db.query(updateUserQuery, [name, phone, userId], (err2) => {

            const updateTenantQuery = `
                UPDATE tenants 
                SET lease_start = ?, lease_end = ?, deposit_amount = ?, id_proof = ?
                WHERE tenant_id = ?
            `;
            db.query(updateTenantQuery, [lease_start, lease_end, deposit_amount, id_proof, tenant_id], (err3) => {
                if (err3) {
                    console.log('Edit tenant error:', err3);
                }
                res.redirect('/manager/tenants');
            });
        });
    });
});

app.post('/manager/tenants/remove', noCache, requireManager, (req, res) => {
    const { tenant_id } = req.body;

    const getApartmentQuery = `SELECT apartment_id FROM tenants WHERE tenant_id = ?`;
    db.query(getApartmentQuery, [tenant_id], (err, results) => {
        if (err || results.length === 0) return res.redirect('/manager/tenants');

        const apartmentId = results[0].apartment_id;

        const deleteTenantQuery = `DELETE FROM tenants WHERE tenant_id = ?`;
        db.query(deleteTenantQuery, [tenant_id], (err2) => {
            if (err2) {
                console.log('Remove tenant error:', err2);
                return res.redirect('/manager/tenants');
            }

            const updateApartmentQuery = `UPDATE apartments SET status = 'vacant' WHERE apartment_id = ?`;
            db.query(updateApartmentQuery, [apartmentId], (err3) => {
                res.redirect('/manager/tenants');
            });
        });
    });
});

app.post('/admin/users/edit', noCache, requireAdmin, (req, res) => {
    const { user_id, name, phone } = req.body;

    const query = `UPDATE users SET name = ?, phone = ? WHERE user_id = ?`;
    db.query(query, [name, phone, user_id], (err) => {
        if (err) {
            console.log('Edit user error:', err);
        }
        res.redirect('/admin/users');
    });
});

app.post('/admin/users/activate', noCache, requireAdmin, (req, res) => {
    const { user_id } = req.body;
    const query = `UPDATE users SET is_active = 1 WHERE user_id = ?`;
    db.query(query, [user_id], (err) => {
        if (err) console.log('Activate user error:', err);
        res.redirect('/admin/users');
    });
});

// Payment Receipt PDF
app.get('/receipt/:payment_id', noCache, requireLogin, (req, res) => {
    const paymentId = req.params.payment_id;

    const query = `
        SELECT pay.*, u.name AS tenant_name, u.email,
               a.apt_number, p.name AS property_name,
               p.address, p.city, p.state, p.pincode
        FROM payments pay
        JOIN tenants t ON pay.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        WHERE pay.payment_id = ?
    `;

    db.query(query, [paymentId], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).send('Receipt not found');
        }

        const pay = results[0];
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 50 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Receipt-${pay.receipt_number}.pdf"`);

        doc.pipe(res);

        // Header
        doc.fontSize(24).font('Helvetica-Bold').text('RentEase', 50, 50);
        doc.fontSize(12).font('Helvetica').fillColor('#666').text('Rental Management System', 50, 80);

        // Title
        doc.moveTo(50, 110).lineTo(550, 110).stroke('#cccccc');
        doc.fontSize(18).font('Helvetica-Bold').fillColor('#2C3E50').text('RENT RECEIPT', 50, 125);
        doc.moveTo(50, 155).lineTo(550, 155).stroke('#cccccc');

        // Receipt details
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Receipt Number:', 50, 175);
        doc.fontSize(11).font('Helvetica').text(pay.receipt_number, 200, 175);

        doc.fontSize(11).font('Helvetica-Bold').text('Payment Date:', 50, 200);
        doc.fontSize(11).font('Helvetica').text(new Date(pay.payment_date).toLocaleDateString('en-IN'), 200, 200);

        doc.fontSize(11).font('Helvetica-Bold').text('Month:', 50, 225);
        doc.fontSize(11).font('Helvetica').text(`${pay.month}/${pay.year}`, 200, 225);

        doc.moveTo(50, 255).lineTo(550, 255).stroke('#cccccc');

        // Tenant details
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#2C3E50').text('Tenant Details', 50, 270);

        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Name:', 50, 295);
        doc.fontSize(11).font('Helvetica').text(pay.tenant_name, 200, 295);

        doc.fontSize(11).font('Helvetica-Bold').text('Email:', 50, 315);
        doc.fontSize(11).font('Helvetica').text(pay.email, 200, 315);

        doc.fontSize(11).font('Helvetica-Bold').text('Property:', 50, 335);
        doc.fontSize(11).font('Helvetica').text(pay.property_name, 200, 335);

        doc.fontSize(11).font('Helvetica-Bold').text('Apartment:', 50, 355);
        doc.fontSize(11).font('Helvetica').text(pay.apt_number, 200, 355);

        doc.fontSize(11).font('Helvetica-Bold').text('Address:', 50, 375);
        doc.fontSize(11).font('Helvetica').text(`${pay.city}, ${pay.state} - ${pay.pincode}`, 200, 375);

        doc.moveTo(50, 405).lineTo(550, 405).stroke('#cccccc');

        // Payment details
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#2C3E50').text('Payment Details', 50, 420);

        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Amount Paid:', 50, 445);
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#27ae60').text(`Rs. ${Number(pay.amount).toLocaleString('en-IN')}`, 200, 443);

        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Payment Method:', 50, 470);
        doc.fontSize(11).font('Helvetica').text(pay.payment_method.replace('_', ' ').toUpperCase(), 200, 470);

        doc.moveTo(50, 500).lineTo(550, 500).stroke('#cccccc');

        // Footer
        doc.fontSize(10).fillColor('#666').text('This is a computer generated receipt and does not require a signature.', 50, 520, { align: 'center' });
        doc.fontSize(10).text('Generated by RentEase Rental Management System', 50, 540, { align: 'center' });

        doc.end();
    });
});

// Monthly Report PDF
app.get('/report/download', noCache, requireLogin, (req, res) => {
    const today = new Date();
    const firstDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDayDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const lastDay = `${lastDayDate.getFullYear()}-${String(lastDayDate.getMonth() + 1).padStart(2, '0')}-${String(lastDayDate.getDate()).padStart(2, '0')}`;

    const fromDate = req.query.from_date || firstDay;
    const toDate = req.query.to_date || lastDay;
    const userId = req.session.user.id;
    const role = req.session.user.role;

    const query = `
        SELECT p.name AS property_name,
               COUNT(a.apartment_id) AS total_units,
               SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
               COALESCE(SUM(CASE WHEN a.status = 'occupied' THEN a.rent_amount ELSE 0 END), 0) AS expected_rent,
               COALESCE((
                   SELECT SUM(pay.amount)
                   FROM payments pay
                   JOIN tenants t ON pay.tenant_id = t.tenant_id
                   JOIN apartments a2 ON t.apartment_id = a2.apartment_id
                   WHERE a2.property_id = p.property_id
                   AND pay.payment_date BETWEEN ? AND ?
               ), 0) AS collected
        FROM properties p
        LEFT JOIN apartments a ON p.property_id = a.property_id
        ${role === 'property_manager' ? 'WHERE p.manager_id = ?' : ''}
        GROUP BY p.property_id
    `;

    const params = role === 'property_manager' ? [fromDate, toDate, userId] : [fromDate, toDate];

    db.query(query, params, (err, rows) => {
        if (err) return res.status(500).send('Error generating report');

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 50 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Report-${fromDate}-to-${toDate}.pdf"`);

        doc.pipe(res);

        doc.fontSize(24).font('Helvetica-Bold').text('RentEase', 50, 50);
        doc.fontSize(12).font('Helvetica').fillColor('#666').text('Rental Management System', 50, 80);

        doc.moveTo(50, 110).lineTo(550, 110).stroke('#cccccc');
        doc.fontSize(18).font('Helvetica-Bold').fillColor('#2C3E50').text('Financial Report', 50, 125);
        doc.fontSize(12).font('Helvetica').fillColor('#666').text(`Period: ${fromDate} to ${toDate}`, 50, 150);
        doc.moveTo(50, 175).lineTo(550, 175).stroke('#cccccc');

        let y = 195;
        doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
        doc.rect(50, y, 500, 22).fill('#2C3E50');
        doc.text('Property', 55, y + 6);
        doc.text('Units', 200, y + 6);
        doc.text('Occupied', 260, y + 6);
        doc.text('Expected', 330, y + 6);
        doc.text('Collected', 420, y + 6);
        doc.text('Pending', 490, y + 6);

        y += 22;

        let totalExpected = 0;
        let totalCollected = 0;

        rows.forEach((row, index) => {
            const bg = index % 2 === 0 ? '#f5f6fa' : '#ffffff';
            doc.rect(50, y, 500, 22).fill(bg);
            doc.fontSize(9).font('Helvetica').fillColor('#333');
            doc.text(row.property_name, 55, y + 6);
            doc.text(String(row.total_units), 200, y + 6);
            doc.text(String(row.occupied), 260, y + 6);
            doc.text(`Rs.${Number(row.expected_rent).toLocaleString('en-IN')}`, 310, y + 6);
            doc.fillColor('#27ae60').text(`Rs.${Number(row.collected).toLocaleString('en-IN')}`, 405, y + 6);
            doc.fillColor('#e74c3c').text(`Rs.${Number(row.expected_rent - row.collected).toLocaleString('en-IN')}`, 475, y + 6);

            totalExpected += Number(row.expected_rent);
            totalCollected += Number(row.collected);
            y += 22;
        });

        doc.rect(50, y, 500, 24).fill('#2C3E50');
        doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
        doc.text('TOTAL', 55, y + 7);
        doc.text(`Rs.${totalExpected.toLocaleString('en-IN')}`, 310, y + 7);
        doc.text(`Rs.${totalCollected.toLocaleString('en-IN')}`, 405, y + 7);
        doc.text(`Rs.${(totalExpected - totalCollected).toLocaleString('en-IN')}`, 475, y + 7);

        y += 40;
        doc.moveTo(50, y).lineTo(550, y).stroke('#cccccc');
        doc.fontSize(10).fillColor('#666').text('Generated by RentEase Rental Management System', 50, y + 15, { align: 'center' });

        doc.end();
    });
});

app.get('/report/excel', noCache, requireLogin, (req, res) => {
    const userId = req.session.user.id;
    const role = req.session.user.role;

    const paymentsQuery = `
        SELECT 
            pay.receipt_number, u.name AS tenant_name, u.email AS tenant_email,
            p.name AS property_name, a.apt_number, p.city,
            a.rent_amount, pay.amount, pay.payment_date,
            pay.payment_method, pay.month, pay.year
        FROM payments pay
        JOIN tenants t ON pay.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        ${role === 'property_manager' ? 'WHERE p.manager_id = ?' : ''}
        ORDER BY pay.payment_date DESC
    `;

    const summaryQuery = `
        SELECT 
            pay.month, pay.year,
            p.name AS property_name,
            COUNT(pay.payment_id) AS total_payments,
            SUM(pay.amount) AS total_collected
        FROM payments pay
        JOIN tenants t ON pay.tenant_id = t.tenant_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        ${role === 'property_manager' ? 'WHERE p.manager_id = ?' : ''}
        GROUP BY pay.year, pay.month, p.property_id
        ORDER BY pay.year DESC, pay.month DESC
    `;

    const maintenanceQuery = `
        SELECT 
            u.name AS tenant_name, p.name AS property_name, a.apt_number,
            mr.title, mr.description, mr.priority, mr.status,
            mr.manager_notes, mr.created_at, mr.updated_at
        FROM maintenance_requests mr
        JOIN tenants t ON mr.tenant_id = t.tenant_id
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        ${role === 'property_manager' ? 'WHERE p.manager_id = ?' : ''}
        ORDER BY mr.created_at DESC
    `;

    const tenantsQuery = `
        SELECT 
            u.name AS tenant_name, u.email, u.phone,
            p.name AS property_name, a.apt_number, a.rent_amount,
            t.lease_start, t.lease_end, t.deposit_amount, t.id_proof,
            CASE WHEN u.is_active = 1 THEN 'Active' ELSE 'Inactive' END AS status
        FROM tenants t
        JOIN users u ON t.user_id = u.user_id
        JOIN apartments a ON t.apartment_id = a.apartment_id
        JOIN properties p ON a.property_id = p.property_id
        ${role === 'property_manager' ? 'WHERE p.manager_id = ?' : ''}
        ORDER BY p.name, u.name
    `;

    const params = role === 'property_manager' ? [userId] : [];

    db.query(paymentsQuery, params, (err, payments) => {
        if (err) payments = [];
        
        db.query(summaryQuery, params, (err2, summary) => {
            if (err2) summary = [];
            
            db.query(maintenanceQuery, params, (err3, maintenance) => {
                if (err3) maintenance = [];
                
                db.query(tenantsQuery, params, (err4, tenants) => {
                    if (err4) tenants = [];

                    const ExcelJS = require('exceljs');
                    const workbook = new ExcelJS.Workbook();
                    workbook.creator = 'RentEase';
                    workbook.created = new Date();

                    // ==================
                    // SHEET 1 - Monthly Summary
                    // ==================
                    const summarySheet = workbook.addWorksheet('Monthly Summary');

                    summarySheet.columns = [
                        { header: 'Year', key: 'year', width: 10 },
                        { header: 'Month', key: 'month', width: 10 },
                        { header: 'Property', key: 'property_name', width: 25 },
                        { header: 'Total Payments', key: 'total_payments', width: 18 },
                        { header: 'Total Collected (Rs)', key: 'total_collected', width: 22 }
                    ];

                    // Header style
                    summarySheet.getRow(1).eachCell((cell) => {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
                        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                        cell.alignment = { vertical: 'middle', horizontal: 'center' };
                        cell.border = { bottom: { style: 'thin', color: { argb: 'FF3498DB' } } };
                    });
                    summarySheet.getRow(1).height = 25;

                    summary.forEach((row, index) => {
                        const dataRow = summarySheet.addRow({
                            year: row.year,
                            month: row.month,
                            property_name: row.property_name,
                            total_payments: row.total_payments,
                            total_collected: Number(row.total_collected)
                        });
                        if (index % 2 === 0) {
                            dataRow.eachCell((cell) => {
                                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6FA' } };
                            });
                        }
                    });

                    // ==================
                    // SHEET 2 - All Payments
                    // ==================
                    const paymentsSheet = workbook.addWorksheet('All Payments');

                    paymentsSheet.columns = [
                        { header: 'Receipt Number', key: 'receipt_number', width: 25 },
                        { header: 'Tenant Name', key: 'tenant_name', width: 20 },
                        { header: 'Email', key: 'tenant_email', width: 25 },
                        { header: 'Property', key: 'property_name', width: 22 },
                        { header: 'Apartment', key: 'apt_number', width: 12 },
                        { header: 'City', key: 'city', width: 15 },
                        { header: 'Rent Amount (Rs)', key: 'rent_amount', width: 18 },
                        { header: 'Amount Paid (Rs)', key: 'amount', width: 18 },
                        { header: 'Payment Date', key: 'payment_date', width: 15 },
                        { header: 'Payment Method', key: 'payment_method', width: 18 },
                        { header: 'Month', key: 'month', width: 10 },
                        { header: 'Year', key: 'year', width: 10 }
                    ];

                    paymentsSheet.getRow(1).eachCell((cell) => {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
                        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                        cell.alignment = { vertical: 'middle', horizontal: 'center' };
                        cell.border = { bottom: { style: 'thin', color: { argb: 'FF3498DB' } } };
                    });
                    paymentsSheet.getRow(1).height = 25;

                    payments.forEach((row, index) => {
                        const dataRow = paymentsSheet.addRow({
                            receipt_number: row.receipt_number,
                            tenant_name: row.tenant_name,
                            tenant_email: row.tenant_email,
                            property_name: row.property_name,
                            apt_number: row.apt_number,
                            city: row.city,
                            rent_amount: Number(row.rent_amount),
                            amount: Number(row.amount),
                            payment_date: new Date(row.payment_date).toLocaleDateString('en-IN'),
                            payment_method: row.payment_method.replace('_', ' ').toUpperCase(),
                            month: row.month,
                            year: row.year
                        });
                        if (index % 2 === 0) {
                            dataRow.eachCell((cell) => {
                                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6FA' } };
                            });
                        }
                    });

                    // ==================
                    // SHEET 3 - Tenants
                    // ==================
                    const tenantsSheet = workbook.addWorksheet('Tenants');

                    tenantsSheet.columns = [
                        { header: 'Tenant Name', key: 'tenant_name', width: 20 },
                        { header: 'Email', key: 'email', width: 25 },
                        { header: 'Phone', key: 'phone', width: 15 },
                        { header: 'Property', key: 'property_name', width: 22 },
                        { header: 'Apartment', key: 'apt_number', width: 12 },
                        { header: 'Rent Amount (Rs)', key: 'rent_amount', width: 18 },
                        { header: 'Lease Start', key: 'lease_start', width: 15 },
                        { header: 'Lease End', key: 'lease_end', width: 15 },
                        { header: 'Deposit (Rs)', key: 'deposit_amount', width: 15 },
                        { header: 'ID Proof', key: 'id_proof', width: 18 },
                        { header: 'Status', key: 'status', width: 12 }
                    ];

                    tenantsSheet.getRow(1).eachCell((cell) => {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
                        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                        cell.alignment = { vertical: 'middle', horizontal: 'center' };
                        cell.border = { bottom: { style: 'thin', color: { argb: 'FF3498DB' } } };
                    });
                    tenantsSheet.getRow(1).height = 25;

                    tenants.forEach((row, index) => {
                        const dataRow = tenantsSheet.addRow({
                            tenant_name: row.tenant_name,
                            email: row.email,
                            phone: row.phone || '—',
                            property_name: row.property_name,
                            apt_number: row.apt_number,
                            rent_amount: Number(row.rent_amount),
                            lease_start: row.lease_start ? new Date(row.lease_start).toLocaleDateString('en-IN') : '—',
                            lease_end: row.lease_end ? new Date(row.lease_end).toLocaleDateString('en-IN') : '—',
                            deposit_amount: Number(row.deposit_amount),
                            id_proof: row.id_proof,
                            status: row.status
                        });
                        if (index % 2 === 0) {
                            dataRow.eachCell((cell) => {
                                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6FA' } };
                            });
                        }
                    });

                    // ==================
                    // SHEET 4 - Maintenance
                    // ==================
                    const maintenanceSheet = workbook.addWorksheet('Maintenance Requests');

                    maintenanceSheet.columns = [
                        { header: 'Tenant Name', key: 'tenant_name', width: 20 },
                        { header: 'Property', key: 'property_name', width: 22 },
                        { header: 'Apartment', key: 'apt_number', width: 12 },
                        { header: 'Issue Title', key: 'title', width: 30 },
                        { header: 'Description', key: 'description', width: 40 },
                        { header: 'Priority', key: 'priority', width: 12 },
                        { header: 'Status', key: 'status', width: 15 },
                        { header: 'Manager Notes', key: 'manager_notes', width: 35 },
                        { header: 'Submitted On', key: 'created_at', width: 18 },
                        { header: 'Updated On', key: 'updated_at', width: 18 }
                    ];

                    maintenanceSheet.getRow(1).eachCell((cell) => {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
                        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                        cell.alignment = { vertical: 'middle', horizontal: 'center' };
                        cell.border = { bottom: { style: 'thin', color: { argb: 'FF3498DB' } } };
                    });
                    maintenanceSheet.getRow(1).height = 25;

                    maintenance.forEach((row, index) => {
                        const dataRow = maintenanceSheet.addRow({
                            tenant_name: row.tenant_name,
                            property_name: row.property_name,
                            apt_number: row.apt_number,
                            title: row.title,
                            description: row.description,
                            priority: row.priority.toUpperCase(),
                            status: row.status.replace('_', ' ').toUpperCase(),
                            manager_notes: row.manager_notes || '—',
                            created_at: new Date(row.created_at).toLocaleDateString('en-IN'),
                            updated_at: new Date(row.updated_at).toLocaleDateString('en-IN')
                        });
                        if (index % 2 === 0) {
                            dataRow.eachCell((cell) => {
                                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6FA' } };
                            });
                        }
                    });

                    // Send file
                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    res.setHeader('Content-Disposition', `attachment; filename="RentEase-Report-${new Date().toISOString().split('T')[0]}.xlsx"`);

                    workbook.xlsx.write(res).then(() => {
                        res.end();
                    });
                });
            });
        });
    });
});

app.get('/manager/occupancy', noCache, requireManager, (req, res) => {
    const managerId = req.session.user.id;

    const occupancyQuery = `
        SELECT 
            p.name AS property_name,
            p.city,
            a.apt_number,
            a.floor,
            a.bedrooms,
            a.rent_amount,
            a.status,
            u.name AS tenant_name,
            u.email AS tenant_email,
            t.lease_start,
            t.lease_end,
            DATEDIFF(t.lease_end, CURDATE()) AS days_until_expiry
        FROM apartments a
        JOIN properties p ON a.property_id = p.property_id
        LEFT JOIN tenants t ON t.apartment_id = a.apartment_id
        LEFT JOIN users u ON t.user_id = u.user_id
        WHERE p.manager_id = ?
        ORDER BY p.name, a.apt_number
    `;

    const statsQuery = `
        SELECT 
            COUNT(*) AS total,
            SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
            SUM(CASE WHEN a.status = 'vacant' THEN 1 ELSE 0 END) AS vacant,
            ROUND(SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) AS occupancy_rate
        FROM apartments a
        JOIN properties p ON a.property_id = p.property_id
        WHERE p.manager_id = ?
    `;

    db.query(occupancyQuery, [managerId], (err, apartments) => {
        db.query(statsQuery, [managerId, managerId], (err2, statsRows) => {
            res.render('manager/occupancy', {
                active: 'occupancy',
                user: req.session.user,
                apartments: err ? [] : apartments,
                stats: err2 ? {} : statsRows[0]
            });
        });
    });
});

app.get('/admin/occupancy', noCache, requireAdmin, (req, res) => {
    const occupancyQuery = `
        SELECT 
            p.name AS property_name,
            p.city,
            p.state,
            a.apt_number,
            a.floor,
            a.bedrooms,
            a.rent_amount,
            a.status,
            u.name AS tenant_name,
            u.email AS tenant_email,
            t.lease_start,
            t.lease_end,
            DATEDIFF(t.lease_end, CURDATE()) AS days_until_expiry
        FROM apartments a
        JOIN properties p ON a.property_id = p.property_id
        LEFT JOIN tenants t ON t.apartment_id = a.apartment_id
        LEFT JOIN users u ON t.user_id = u.user_id
        ORDER BY p.name, a.apt_number
    `;

    const statsQuery = `
        SELECT 
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
            SUM(CASE WHEN status = 'vacant' THEN 1 ELSE 0 END) AS vacant,
            ROUND(SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) AS occupancy_rate
        FROM apartments
    `;

    db.query(occupancyQuery, (err, apartments) => {
        db.query(statsQuery, (err2, statsRows) => {
            res.render('admin/occupancy', {
                active: 'occupancy',
                user: req.session.user,
                apartments: err ? [] : apartments,
                stats: err2 ? {} : statsRows[0]
            });
        });
    });
});

process.on('uncaughtException', (err) => {
    console.log('Uncaught Exception:', err.message);
    console.log(err.stack);
});

// Start server
app.listen(3000, () => {
    console.log('RentEase running on http://localhost:3000');
});
