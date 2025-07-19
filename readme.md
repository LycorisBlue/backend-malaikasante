# Guide Architecture Backend - Plateforme Médecins-Patients
## 🎯 Comprendre et Maîtriser la Structure

---

## 📁 Rôle de Chaque Dossier

### **`app.js`** - Point d'entrée Express
**Rôle** : Configuration principale du serveur Express
```javascript
const express = require('express');
const cookieParser = require('cookie-parser');
const logger = require('morgan');

const v1Router = require('./routes/v1');
const app = express();

// Middleware globaux
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Routes principales
app.use('/v1', v1Router);

module.exports = app;
```

### **`bin/www`** - Serveur HTTP
**Rôle** : Démarrage du serveur avec gestion des environnements
```javascript
#!/usr/bin/env node
var app = require('../app');
var http = require('http');

// Port selon environnement
const portMap = {
  development: 3000,
  test: 3001, 
  production: 8080
};

const port = portMap[process.env.NODE_ENV] || 3000;
app.set('port', port);

var server = http.createServer(app);
server.listen(port);
console.log(`🚀 Serveur démarré sur le port ${port}`);
```

---

## 📂 **`config/`** - Configuration Centralisée

### **`config/const.js`** - Constantes globales
**Rôle** : Toutes les configurations en un seul endroit
```javascript
const dayjs = require('dayjs');

class Consts {
    // Informations app
    static APP_NAME = "Plateforme Médecins-Patients";
    static APP_AUTHOR = "MEDEV GROUP";
    
    // JWT selon environnement
    static JWT_SECRET = (() => {
        const env = process.env.NODE_ENV || 'development';
        switch (env) {
            case 'production': return process.env.JWT_SECRET_PROD;
            case 'test': return process.env.JWT_SECRET_TEST;
            default: return process.env.JWT_SECRET_DEV;
        }
    })();
    
    // Configuration SMS LeTexto (Côte d'Ivoire)
    static SMS_CONFIG = {
        baseUrl: process.env.LETEXTO_API_URL,
        apiKey: process.env.LETEXTO_API_KEY,
        sender: 'MEDECINS',
        countryCode: '225'
    };
    
    // Configuration OTP
    static OTP_CONFIG = {
        length: 4,
        expirationMinutes: 5,
        maxAttempts: 3
    };
    
    static getDateLib() {
        return dayjs;
    }
}

module.exports = Consts;
```

### **`config/swagger.js`** - Documentation API
**Rôle** : Configuration automatique de la documentation Swagger
```javascript
const swaggerJsdoc = require('swagger-jsdoc');

const getServers = () => {
    const environment = process.env.NODE_ENV || 'development';
    const servers = [];
    
    switch (environment) {
        case 'production':
            servers.push({
                url: 'https://api.medecins-patients.ci',
                description: 'Serveur de production'
            });
            break;
        default:
            servers.push({
                url: 'http://localhost:3000',
                description: 'Serveur de développement'
            });
    }
    return servers;
};

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'API Plateforme Médecins-Patients',
            version: '1.0.0',
            description: 'Documentation API pour la mise en relation médecins-patients'
        },
        servers: getServers()
    },
    apis: ['./swagger/**/*.yaml']
};

module.exports = swaggerJsdoc(options);
```

---

## 🛡️ **`middleware/`** - Couches de Sécurité

### **`middleware/authMiddleware.js`** - Authentification & Autorisation
**Rôle** : Vérifier les tokens JWT et gérer les permissions par rôle
```javascript
const TokenService = require('../services/TokenService');
const ApiResponse = require('../services/ApiResponse');
const prisma = require('../prisma/client');

class AuthMiddleware {
    /**
     * Vérifie que l'utilisateur est authentifié
     */
    static authenticate() {
        return async (req, res, next) => {
            try {
                const authHeader = req.headers.authorization;
                
                // Vérification présence token
                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    return ApiResponse.unauthorized(res, 'Token d\'authentification requis');
                }
                
                const token = authHeader.substring(7);
                
                // Validation token
                const tokenCheck = TokenService.checkToken(token);
                if (!tokenCheck.isValid) {
                    return ApiResponse.unauthorized(res, 'Token invalide');
                }
                
                // Récupération utilisateur
                const user = await prisma.user.findUnique({
                    where: { 
                        id: tokenCheck.payload.userId,
                        statut: 'ACTIF'
                    },
                    include: {
                        patient: true,
                        medecin: true
                    }
                });
                
                if (!user) {
                    return ApiResponse.unauthorized(res, 'Utilisateur non trouvé');
                }
                
                req.user = user;
                req.token = token;
                next();
                
            } catch (error) {
                console.error('Erreur auth:', error);
                return ApiResponse.serverError(res, 'Erreur d\'authentification');
            }
        };
    }
    
    /**
     * Vérifie les rôles autorisés
     */
    static authorize(allowedRoles) {
        return (req, res, next) => {
            if (!req.user) {
                return ApiResponse.unauthorized(res, 'Authentification requise');
            }
            
            const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
            
            if (!roles.includes(req.user.role)) {
                return ApiResponse.unauthorized(res, 'Permissions insuffisantes');
            }
            
            next();
        };
    }
}

module.exports = AuthMiddleware;
```

### **`middleware/bodyFilterMiddleware.js`** - Validation des Données
**Rôle** : Filtrer et valider les données reçues dans les requêtes
```javascript
const ApiResponse = require('../services/ApiResponse');

class BodyFilter {
    /**
     * Filtre les champs autorisés et vérifie les champs obligatoires
     */
    static filter(schema) {
        return (req, res, next) => {
            try {
                const { required = [], allowed = [], strict = true } = schema;
                const bodyKeys = Object.keys(req.body || {});
                
                // Vérification champs manquants
                const missingFields = required.filter(field => 
                    !(field in req.body) || 
                    req.body[field] === null || 
                    req.body[field] === undefined || 
                    req.body[field] === ''
                );
                
                if (missingFields.length > 0) {
                    return ApiResponse.badRequest(res, 'Champs manquants', {
                        missingFields,
                        message: `Champs obligatoires: ${missingFields.join(', ')}`
                    });
                }
                
                // Vérification champs non autorisés
                if (strict && allowed.length > 0) {
                    const unauthorizedFields = bodyKeys.filter(field => !allowed.includes(field));
                    
                    if (unauthorizedFields.length > 0) {
                        return ApiResponse.badRequest(res, 'Champs non autorisés', {
                            unauthorizedFields,
                            allowedFields: allowed
                        });
                    }
                }
                
                next();
            } catch (error) {
                console.error('Erreur bodyFilter:', error);
                return ApiResponse.serverError(res, 'Erreur de validation');
            }
        };
    }
}

module.exports = BodyFilter;
```

---

## 🗄️ **`prisma/`** - Base de Données

### **`prisma/client.js`** - Client Prisma
**Rôle** : Instance Prisma réutilisable dans toute l'app
```javascript
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn'] : ['warn'],
});

module.exports = prisma;
```

### **`prisma/schema.prisma`** - Modèle de Données (extrait)
**Rôle** : Définition de la structure de base de données
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

enum Role {
  PATIENT
  MEDECIN
  ADMIN
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  telephone String   @unique
  nom       String
  prenom    String
  role      Role
  statut    StatutUser @default(ACTIF)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  // Relations
  patient   Patient?
  medecin   Medecin?
  tokens    UserToken[]
  
  @@map("users")
}

model Patient {
  id                  String @id @default(uuid())
  userId              String @unique
  dateNaissance       DateTime?
  allergies           String?  // Données chiffrées
  antecedentsMedicaux String?  // Données chiffrées
  
  user        User         @relation(fields: [userId], references: [id])
  rendezVous  RendezVous[]
  
  @@map("patients")
}
```

---

## 🔧 **`services/`** - Services Métier

### **`services/ApiResponse.js`** - Réponses Standardisées
**Rôle** : Uniformiser toutes les réponses HTTP de l'API
```javascript
class ApiResponse {
    static success(res, message, data = null) {
        return res.status(200).json({ message, data });
    }
    
    static created(res, message, data = null) {
        return res.status(201).json({ message, data });
    }
    
    static badRequest(res, message, data = null) {
        return res.status(400).json({ message, data });
    }
    
    static unauthorized(res, message, data = null) {
        return res.status(401).json({ message, data });
    }
    
    static notFound(res, message, data = null) {
        return res.status(404).json({ message, data });
    }
    
    static serverError(res, message, data = null) {
        return res.status(500).json({ message, data });
    }
}

module.exports = ApiResponse;
```

### **`services/TokenService.js`** - Gestion JWT
**Rôle** : Créer, vérifier et révoquer les tokens d'authentification
```javascript
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');
const Consts = require('../config/const');

class TokenService {
    /**
     * Génère un token d'accès selon le rôle
     */
    static async generateToken(user) {
        const payload = { userId: user.id, role: user.role };
        
        // Durée selon le rôle
        let expiresIn;
        switch (user.role) {
            case 'ADMIN':
            case 'MEDECIN':
                expiresIn = '1d';
                break;
            case 'PATIENT':
            default:
                expiresIn = '7d';
        }
        
        const token = jwt.sign(payload, Consts.JWT_SECRET, { expiresIn });
        
        // Sauvegarde en base pour révocation
        await prisma.userToken.create({
            data: {
                userId: user.id,
                typeToken: 'ACCESS',
                tokenHash: token,
                dateExpiration: new Date(Date.now() + this._getExpirationMs(expiresIn))
            }
        });
        
        return token;
    }
    
    /**
     * Vérifie la validité d'un token
     */
    static checkToken(token) {
        try {
            const payload = jwt.verify(token, Consts.JWT_SECRET);
            return { isValid: true, payload };
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return {
                    isValid: false,
                    expired: true,
                    message: 'Token expiré, veuillez vous reconnecter'
                };
            }
            return { isValid: false, message: 'Token invalide' };
        }
    }
    
    static _getExpirationMs(expiresIn) {
        const match = expiresIn.match(/^(\d+)([smhdy])$/);
        if (!match) return 0;
        
        const [_, value, unit] = match;
        const multipliers = {
            s: 1000,
            m: 60 * 1000,
            h: 60 * 60 * 1000,
            d: 24 * 60 * 60 * 1000
        };
        
        return parseInt(value, 10) * (multipliers[unit] || 0);
    }
}

module.exports = TokenService;
```

### **`services/SmsService.js`** - Envoi SMS
**Rôle** : Gérer l'envoi des SMS via l'API LeTexto
```javascript
const axios = require('axios');
const Consts = require('../config/const');

class SmsService {
    /**
     * Génère un code OTP
     */
    static generateOtp(length = Consts.OTP_CONFIG.length) {
        const digits = '0123456789';
        let otp = '';
        for (let i = 0; i < length; i++) {
            otp += digits[Math.floor(Math.random() * digits.length)];
        }
        return otp;
    }
    
    /**
     * Envoie un SMS via LeTexto
     */
    static async sendSms(phone, message) {
        try {
            const { baseUrl, apiKey, sender, countryCode } = Consts.SMS_CONFIG;
            
            const endpoint = `/messages/send?token=${apiKey}&from=${sender}&to=${countryCode}${phone}&content=${encodeURIComponent(message)}`;
            
            const response = await axios.get(`${baseUrl}${endpoint}`, {
                timeout: 10000
            });
            
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error('Erreur SMS:', error.message);
            return {
                success: false,
                message: error.message
            };
        }
    }
    
    /**
     * Envoie un code OTP par SMS
     */
    static async sendOtp(phone, otp) {
        const message = `Votre code de vérification Médecins-Patients est: ${otp}. Valable ${Consts.OTP_CONFIG.expirationMinutes} minutes.`;
        return await this.sendSms(phone, message);
    }
}

module.exports = SmsService;
```

---

## 🎯 **`controllers/`** - Logique Métier

### **`controllers/PatientController.js`** - Gestion Patients
**Rôle** : Toute la logique métier concernant les patients
```javascript
const express = require('express');
const router = express.Router();

// Import des routes spécialisées
const registerRoute = require('../routes/patients/register');
const profileRoute = require('../routes/patients/profile');
const medicalDataRoute = require('../routes/patients/medical-data');

// Organisation modulaire des routes
router.use('/register', registerRoute);
router.use('/profile', profileRoute);
router.use('/medical-data', medicalDataRoute);

module.exports = router;
```

### **`controllers/MedecinController.js`** - Gestion Médecins
**Rôle** : Logique métier pour les médecins
```javascript
const express = require('express');
const router = express.Router();

// Import routes médecins
const searchRoute = require('../routes/medecins/search');
const availabilityRoute = require('../routes/medecins/availability');
const validationRoute = require('../routes/medecins/validation');

router.use('/search', searchRoute);
router.use('/availability', availabilityRoute);
router.use('/validation', validationRoute);

module.exports = router;
```

---

## 🛣️ **`routes/`** - Endpoints Spécifiques

### **`routes/v1.js`** - Router Principal
**Rôle** : Point d'entrée de toutes les routes API v1
```javascript
const express = require('express');
const router = express.Router();

// Import des contrôleurs
const authController = require('../controllers/AuthController');
const patientController = require('../controllers/PatientController');
const medecinController = require('../controllers/MedecinController');

// Organisation des routes principales
router.use('/auth', authController);
router.use('/patients', patientController);
router.use('/medecins', medecinController);

// Documentation Swagger
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('../config/swagger');
router.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

module.exports = router;
```

### **`routes/patients/profile.js`** - Route Spécifique
**Rôle** : Endpoint dédié à la gestion du profil patient
```javascript
const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const ApiResponse = require('../../services/ApiResponse');
const { authenticate, authorize } = require('../../middleware/authMiddleware');
const BodyFilter = require('../../middleware/bodyFilterMiddleware');

// Schéma de validation
const profileSchema = {
    required: [],
    allowed: ['nom', 'prenom', 'telephone', 'dateNaissance', 'sexe'],
    strict: true
};

/**
 * GET /v1/patients/profile - Récupérer le profil patient
 */
router.get('/',
    authenticate(),
    authorize(['PATIENT']),
    async (req, res) => {
        try {
            const patient = await prisma.patient.findUnique({
                where: { userId: req.user.id },
                include: {
                    user: {
                        select: {
                            nom: true,
                            prenom: true,
                            email: true,
                            telephone: true
                        }
                    }
                }
            });
            
            if (!patient) {
                return ApiResponse.notFound(res, 'Profil patient non trouvé');
            }
            
            return ApiResponse.success(res, 'Profil récupéré', {
                id: patient.id,
                ...patient.user,
                dateNaissance: patient.dateNaissance,
                sexe: patient.sexe
            });
            
        } catch (error) {
            console.error('Erreur récupération profil:', error);
            return ApiResponse.serverError(res, 'Erreur serveur');
        }
    }
);

/**
 * PUT /v1/patients/profile - Mettre à jour le profil
 */
router.put('/',
    authenticate(),
    authorize(['PATIENT']),
    BodyFilter.filter(profileSchema),
    async (req, res) => {
        try {
            const { nom, prenom, telephone, dateNaissance, sexe } = req.body;
            
            // Mise à jour User
            const updatedUser = await prisma.user.update({
                where: { id: req.user.id },
                data: {
                    nom: nom || req.user.nom,
                    prenom: prenom || req.user.prenom,
                    telephone: telephone || req.user.telephone
                }
            });
            
            // Mise à jour Patient
            const updatedPatient = await prisma.patient.update({
                where: { userId: req.user.id },
                data: {
                    dateNaissance: dateNaissance ? new Date(dateNaissance) : undefined,
                    sexe: sexe || undefined
                }
            });
            
            return ApiResponse.success(res, 'Profil mis à jour', {
                nom: updatedUser.nom,
                prenom: updatedUser.prenom,
                telephone: updatedUser.telephone,
                dateNaissance: updatedPatient.dateNaissance,
                sexe: updatedPatient.sexe
            });
            
        } catch (error) {
            console.error('Erreur mise à jour profil:', error);
            return ApiResponse.serverError(res, 'Erreur serveur');
        }
    }
);

module.exports = router;
```

---

## 🔗 Processus Complet : Créer un Endpoint

### Étape 1 : Créer la Route Spécifique
```javascript
// routes/medecins/search.js
const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const ApiResponse = require('../../services/ApiResponse');

router.get('/', async (req, res) => {
    try {
        const { specialite, ville, latitude, longitude } = req.query;
        
        const medecins = await prisma.medecin.findMany({
            where: {
                statutValidation: 'VALIDE',
                specialites: specialite ? { contains: specialite } : undefined
            },
            include: {
                user: {
                    select: { nom: true, prenom: true }
                },
                clinique: true
            }
        });
        
        return ApiResponse.success(res, 'Médecins trouvés', medecins);
    } catch (error) {
        return ApiResponse.serverError(res, 'Erreur recherche');
    }
});

module.exports = router;
```

### Étape 2 : Ajouter au Contrôleur
```javascript
// controllers/MedecinController.js
const searchRoute = require('../routes/medecins/search');
router.use('/search', searchRoute);
```

### Étape 3 : Connecter au Router Principal
```javascript
// routes/v1.js
const medecinController = require('../controllers/MedecinController');
router.use('/medecins', medecinController);
```

### Étape 4 : Le Router est déjà connecté à app.js
```javascript
// app.js
const v1Router = require('./routes/v1');
app.use('/v1', v1Router);
```

### Résultat : Endpoint Accessible
```
GET /v1/medecins/search?specialite=CARDIOLOGIE&ville=Abidjan
```

---

## 📋 Fichiers de Base Obligatoires

### Configuration Minimum
```
├── 📁 .env                    # Variables d'environnement
├── 📁 package.json           # Dépendances npm
├── 📁 app.js                 # Point d'entrée Express
├── 📁 bin/www                # Serveur HTTP
└── 📁 config/
    ├── const.js              # Constantes globales
    └── swagger.js            # Documentation API
```

### Structure Prisma
```
└── 📁 prisma/
    ├── schema.prisma         # Modèle de données
    ├── client.js             # Client Prisma
    └── migrations/           # Évolutions base
```

### Services Essentiels
```
└── 📁 services/
    ├── ApiResponse.js        # Réponses standardisées
    ├── TokenService.js       # Gestion JWT
    └── SmsService.js         # SMS LeTexto
```

### Middleware Sécuritaire
```
└── 📁 middleware/
    ├── authMiddleware.js     # Auth + autorisation
    └── bodyFilterMiddleware.js # Validation données
```

### Architecture Routes
```
└── 📁 routes/
    ├── v1.js                 # Router principal
    └── 📁 [domaine]/         # Routes par domaine métier
        └── [endpoint].js     # Endpoint spécifique
```

### Contrôleurs Métier
```
└── 📁 controllers/
    ├── AuthController.js     # Authentification
    ├── PatientController.js  # Logique patients
    └── MedecinController.js  # Logique médecins
```

---

## 🚀 Scripts de Démarrage

### package.json
```json
{
  "name": "medecins-patients-backend",
  "scripts": {
    "start": "node ./bin/www",
    "dev": "nodemon ./bin/www",
    "db:migrate": "npx prisma migrate dev",
    "db:generate": "npx prisma generate",
    "db:seed": "node prisma/seed.js"
  },
  "dependencies": {
    "express": "^4.21.2",
    "prisma": "^6.12.0",
    "@prisma/client": "^6.12.0",
    "jsonwebtoken": "^9.0.2",
    "bcrypt": "^6.0.0",
    "axios": "^1.10.0",
    "express-validator": "^7.2.1",
    "swagger-ui-express": "^5.0.1",
    "swagger-jsdoc": "^6.2.8"
  }
}
```

Cette architecture te donne une base solide pour développer tous tes endpoints selon le pattern établi : Route → Contrôleur → Service → Base de données.