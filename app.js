const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const session = require('express-session');

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
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const summaryQuery = `
        SELECT 
            (SELECT COUNT(*) FROM properties) AS total_properties,
            (SELECT COUNT(*) FROM apartments) AS total_apartments,
            (SELECT COUNT(*) FROM apartments WHERE status = 'occupied') AS occupied_apartments,
            (SELECT COUNT(*) FROM tenants) AS total_tenants,
            (SELECT COALESCE(SUM(amount), 0) FROM payments 
             WHERE MONTH(payment_date) = ? AND YEAR(payment_date) = ?) AS rent_collected
    `;

    const propertyBreakdownQuery = `
        SELECT p.name, 
               COUNT(a.apartment_id) AS total_units,
               SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
               COALESCE(SUM(a.rent_amount * (a.status = 'occupied')), 0) AS expected_rent,
               COALESCE((
                   SELECT SUM(pay.amount) 
                   FROM payments pay
                   JOIN tenants t ON pay.tenant_id = t.tenant_id
                   JOIN apartments apt ON t.apartment_id = apt.apartment_id
                   WHERE apt.property_id = p.property_id
                   AND MONTH(pay.payment_date) = ? 
                   AND YEAR(pay.payment_date) = ?
               ), 0) AS collected
        FROM properties p
        LEFT JOIN apartments a ON p.property_id = a.property_id
        GROUP BY p.property_id
    `;

    db.query(summaryQuery, [month, year], (err, summaryRows) => {
        const summary = err ? {} : summaryRows[0];

        db.query(propertyBreakdownQuery, [month, year], (err2, breakdown) => {
            res.render('admin/reports', {
                active: 'reports',
                user: req.session.user,
                summary: summary,
                breakdown: err2 ? [] : breakdown,
                month: month,
                year: year
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
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const summaryQuery = `
        SELECT 
            COUNT(DISTINCT a.apartment_id) AS total_apartments,
            SUM(CASE WHEN a.status = 'occupied' THEN 1 ELSE 0 END) AS occupied,
            SUM(CASE WHEN a.status = 'vacant' THEN 1 ELSE 0 END) AS vacant,
            COALESCE(SUM(CASE WHEN a.status = 'occupied' THEN a.rent_amount ELSE 0 END), 0) AS total_expected,
            COALESCE((
                SELECT SUM(pay.amount)
                FROM payments pay
                JOIN tenants t2 ON pay.tenant_id = t2.tenant_id
                JOIN apartments a2 ON t2.apartment_id = a2.apartment_id
                JOIN properties p2 ON a2.property_id = p2.property_id
                WHERE p2.manager_id = ?
                AND MONTH(pay.payment_date) = ?
                AND YEAR(pay.payment_date) = ?
            ), 0) AS total_collected
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
                   AND MONTH(pay.payment_date) = ?
                   AND YEAR(pay.payment_date) = ?
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
            AND MONTH(pay.payment_date) = ?
            AND YEAR(pay.payment_date) = ?
        WHERE p.manager_id = ?
        ORDER BY status, u.name
    `;

    db.query(summaryQuery, [managerId, month, year, managerId], (err, summaryRows) => {
        const summary = err ? {} : summaryRows[0];

        db.query(breakdownQuery, [month, year, managerId], (err2, breakdown) => {
            db.query(tenantPaymentsQuery, [month, year, managerId], (err3, tenantPayments) => {
                res.render('manager/reports', {
                    active: 'reports',
                    user: req.session.user,
                    summary: summary,
                    breakdown: err2 ? [] : breakdown,
                    tenantPayments: err3 ? [] : tenantPayments,
                    month: month,
                    year: year
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

    // Check if email already exists
    const checkQuery = 'SELECT * FROM users WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (results && results.length > 0) {
            return res.redirect('/manager/tenants');
        }

        // Create user account first
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

            // Create tenant record
            const insertTenantQuery = `
                INSERT INTO tenants (user_id, apartment_id, lease_start, lease_end, deposit_amount, id_proof)
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            db.query(insertTenantQuery, [newUserId, apartment_id, lease_start, lease_end, deposit_amount, id_proof], (err2) => {
                if (err2) {
                    console.log('Add tenant record error:', err2);
                    return res.redirect('/manager/tenants');
                }

                // Update apartment status to occupied
                const updateApartmentQuery = `UPDATE apartments SET status = 'occupied' WHERE apartment_id = ?`;
                db.query(updateApartmentQuery, [apartment_id], (err3) => {
                    if (err3) {
                        console.log('Update apartment status error:', err3);
                    }
                    res.redirect('/manager/tenants');
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

// Start server
app.listen(3000, () => {
    console.log('RentEase running on http://localhost:3000');
});