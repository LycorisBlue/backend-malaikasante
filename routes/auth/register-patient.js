const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const ApiResponse = require('../../services/ApiResponse');
const TokenService = require('../../services/TokenService');
const BodyFilter = require('../../middleware/bodyFilterMiddleware');
const Consts = require('../../config/const');

// Schéma de validation (PAS de password pour les patients)
const registerPatientSchema = {
    fields: {
        nom: {
            type: 'string',
            minLength: 2,
            maxLength: 100
        },
        prenom: {
            type: 'string',
            minLength: 2,
            maxLength: 100
        },
        telephone: {
            type: 'phone'
        },
        email: {
            type: 'email'
        },
        dateNaissance: {
            type: 'date'
        },
        sexe: {
            type: 'string',
            enum: ['M', 'F', 'AUTRE']
        }
    },
    required: ['nom', 'prenom', 'telephone', 'email'], // 👈 PAS de password
    strict: true
};

/**
 * POST /auth/register/patient - Inscription d'un nouveau patient (SANS mot de passe)
 */
router.post('/',
    BodyFilter.validate(registerPatientSchema),
    async (req, res) => {
        try {
            const { nom, prenom, telephone, email, dateNaissance, sexe } = req.body;
            const clientIp = req.ip || req.connection.remoteAddress;

            console.log(`👤 Inscription patient: ${prenom} ${nom} - Tel: ${telephone} - IP: ${clientIp}`);

            // Nettoyage du numéro
            const cleanPhone = telephone.replace(/[^0-9]/g, '');

            // Vérifier que le numéro a été validé par OTP récemment (dans les 10 dernières minutes)
            const recentValidatedOtp = await prisma.otp.findFirst({
                where: {
                    telephone: cleanPhone,
                    utilise: true,
                    createdAt: {
                        gte: new Date(Date.now() - (10 * 60 * 1000)) // 10 minutes
                    }
                },
                orderBy: { createdAt: 'desc' }
            });

            if (!recentValidatedOtp) {
                console.log(`❌ Numéro non vérifié pour ${cleanPhone}`);
                return ApiResponse.badRequest(res, 'Numéro de téléphone non vérifié', {
                    code: 'PHONE_NOT_VERIFIED',
                    message: 'Vous devez d\'abord vérifier votre numéro de téléphone avec un code OTP.',
                    action: 'Demandez un code OTP pour ce numéro'
                });
            }

            // Vérifier l'unicité de l'email
            const existingUserByEmail = await prisma.user.findUnique({
                where: { email },
                select: { id: true, email: true }
            });

            if (existingUserByEmail) {
                console.log(`❌ Email déjà utilisé: ${email}`);
                return ApiResponse.badRequest(res, 'Adresse email déjà utilisée', {
                    code: 'EMAIL_ALREADY_EXISTS',
                    message: 'Cette adresse email est déjà associée à un compte.',
                    field: 'email'
                });
            }

            // Vérifier l'unicité du téléphone
            const existingUserByPhone = await prisma.user.findUnique({
                where: { telephone: cleanPhone },
                select: { id: true, telephone: true, role: true }
            });

            if (existingUserByPhone) {
                console.log(`❌ Téléphone déjà utilisé: ${cleanPhone} (${existingUserByPhone.role})`);
                return ApiResponse.badRequest(res, 'Numéro de téléphone déjà utilisé', {
                    code: 'PHONE_ALREADY_EXISTS',
                    message: `Ce numéro est déjà associé à un compte ${existingUserByPhone.role.toLowerCase()}.`,
                    field: 'telephone'
                });
            }

            // Validation de la date de naissance (si fournie)
            let dateNaissanceParsed = null;
            if (dateNaissance) {
                dateNaissanceParsed = new Date(dateNaissance);
                const today = new Date();
                const age = Math.floor((today - dateNaissanceParsed) / (365.25 * 24 * 60 * 60 * 1000));

                if (age < 0 || age > 120) {
                    return ApiResponse.badRequest(res, 'Date de naissance invalide', {
                        code: 'INVALID_BIRTH_DATE',
                        message: 'La date de naissance doit correspondre à un âge entre 0 et 120 ans.',
                        field: 'dateNaissance'
                    });
                }
            }

            // Création de l'utilisateur et du patient en transaction
            const result = await prisma.$transaction(async (tx) => {
                // Créer l'utilisateur SANS mot de passe (les patients utilisent OTP)
                const newUser = await tx.user.create({
                    data: {
                        nom: nom.trim(),
                        prenom: prenom.trim(),
                        telephone: cleanPhone,
                        email: email.toLowerCase().trim(),
                        password: null, // 👈 PAS de mot de passe pour les patients
                        role: 'PATIENT',
                        statut: 'ACTIF',
                        canalCommunicationPrefere: 'SMS'
                    }
                });

                // Créer le profil patient
                const newPatient = await tx.patient.create({
                    data: {
                        userId: newUser.id,
                        dateNaissance: dateNaissanceParsed,
                        sexe: sexe || null,
                        ville: 'Abidjan',
                        abonneContenuPro: false
                    }
                });

                return { user: newUser, patient: newPatient };
            });

            // Générer les tokens JWT (connexion automatique après inscription)
            const accessToken = TokenService.generateToken(result.user);
            const refreshToken = TokenService.generateRefreshToken(result.user);

            // Préparer les informations utilisateur
            const userInfo = {
                id: result.user.id,
                telephone: result.user.telephone,
                email: result.user.email,
                nom: result.user.nom,
                prenom: result.user.prenom,
                role: result.user.role,
                statut: result.user.statut,
                hasPassword: false, // 👈 Indique que ce patient n'a pas de mot de passe
                authMethod: 'OTP_ONLY', // 👈 Méthode d'authentification
                patient: {
                    id: result.patient.id,
                    dateNaissance: result.patient.dateNaissance,
                    sexe: result.patient.sexe,
                    ville: result.patient.ville,
                    abonneContenuPro: result.patient.abonneContenuPro
                }
            };

            console.log(`✅ Patient créé avec succès: ${result.user.prenom} ${result.user.nom} (ID: ${result.user.id})`);

            // Réponse de succès
            return ApiResponse.created(res, 'Compte patient créé avec succès', {
                user: userInfo,
                tokens: {
                    accessToken,
                    refreshToken,
                    expiresIn: Consts.JWT_EXPIRATION.PATIENT.access
                },
                accountInfo: {
                    createdAt: result.user.createdAt,
                    ip: clientIp,
                    isEmailVerified: false,
                    isPhoneVerified: true,
                    accountType: 'PATIENT',
                    authenticationMethod: 'OTP_ONLY'
                },
                nextSteps: [
                    'Votre compte patient est actif et connecté',
                    'Pas besoin de mot de passe - utilisez toujours l\'OTP pour vous connecter',
                    'Vous pouvez maintenant rechercher des médecins',
                    'Complétez votre profil médical pour une meilleure expérience'
                ]
            });

        } catch (error) {
            console.error('❌ Erreur inscription patient:', error);

            // Gestion des erreurs Prisma spécifiques
            if (error.code === 'P2002') {
                const target = error.meta?.target;
                if (target?.includes('email')) {
                    return ApiResponse.badRequest(res, 'Adresse email déjà utilisée', {
                        code: 'EMAIL_ALREADY_EXISTS',
                        field: 'email'
                    });
                }
                if (target?.includes('telephone')) {
                    return ApiResponse.badRequest(res, 'Numéro de téléphone déjà utilisé', {
                        code: 'PHONE_ALREADY_EXISTS',
                        field: 'telephone'
                    });
                }
            }

            return ApiResponse.serverError(res, 'Erreur interne lors de la création du compte');
        }
    }
);

module.exports = router;