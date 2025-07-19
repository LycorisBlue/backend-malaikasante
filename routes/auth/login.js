const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const prisma = require('../../prisma/client');
const ApiResponse = require('../../services/ApiResponse');
const TokenService = require('../../services/TokenService');
const BodyFilter = require('../../middleware/bodyFilterMiddleware');
const Consts = require('../../config/const');

// Schéma de validation
const loginSchema = {
    fields: {
        email: {
            type: 'email'
        },
        password: {
            type: 'string',
            minLength: 1,
            maxLength: 100
        }
    },
    required: ['email', 'password'],
    strict: true
};

/**
 * POST /auth/login - Connexion avec email et mot de passe
 * Exclusivement pour les médecins (patients utilisent OTP)
 */
router.post('/',
    BodyFilter.validate(loginSchema),
    async (req, res) => {
        try {
            const { email, password } = req.body;
            const clientIp = req.ip || req.connection.remoteAddress;

            console.log(`🔐 Tentative connexion: ${email} - IP: ${clientIp}`);

            // Recherche de l'utilisateur par email
            const user = await prisma.user.findUnique({
                where: { email: email.toLowerCase().trim() },
                select: {
                    id: true,
                    email: true,
                    nom: true,
                    prenom: true,
                    password: true,
                    role: true,
                    statut: true,
                    medecin: {
                        select: {
                            statutValidation: true,
                            motifRejet: true
                        }
                    }
                }
            });

            if (!user) {
                console.log(`❌ Email non trouvé: ${email}`);
                return ApiResponse.badRequest(res, 'Identifiants incorrects', {
                    code: 'INVALID_CREDENTIALS',
                    message: 'Email ou mot de passe incorrect.'
                });
            }

            // INTERDIRE la connexion pour les patients (doivent utiliser OTP)
            if (user.role === 'PATIENT') {
                console.log(`❌ Tentative login patient via email: ${email}`);
                return ApiResponse.badRequest(res, 'Méthode de connexion incorrecte', {
                    code: 'WRONG_AUTH_METHOD',
                    message: 'Les patients se connectent uniquement par SMS avec un code de vérification.',
                    correctMethod: 'OTP_SMS',
                    instructions: [
                        'Utilisez votre numéro de téléphone pour recevoir un code SMS',
                        'Endpoint: POST /v1/auth/otp/send puis POST /v1/auth/otp/verify'
                    ]
                });
            }

            // Vérifier que l'utilisateur a un mot de passe
            if (!user.password) {
                console.log(`❌ Compte sans password: ${email} (${user.role})`);
                return ApiResponse.badRequest(res, 'Compte sans mot de passe', {
                    code: 'NO_PASSWORD_SET',
                    message: 'Ce compte n\'a pas de mot de passe configuré.'
                });
            }

            // Vérification du mot de passe
            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) {
                console.log(`❌ Mot de passe incorrect pour: ${email}`);
                return ApiResponse.badRequest(res, 'Identifiants incorrects', {
                    code: 'INVALID_CREDENTIALS',
                    message: 'Email ou mot de passe incorrect.'
                });
            }

            // Vérifier le statut du compte
            if (user.statut !== 'ACTIF') {
                console.log(`❌ Compte inactif: ${email} - Statut: ${user.statut}`);

                let message = 'Votre compte n\'est pas actif.';
                if (user.statut === 'SUSPENDU') {
                    message = 'Votre compte est temporairement suspendu. Contactez l\'administration.';
                } else if (user.statut === 'DESACTIVE') {
                    message = 'Votre compte a été désactivé. Contactez l\'administration.';
                }

                return ApiResponse.forbidden(res, message, {
                    statut: user.statut,
                    contact: {
                        email: 'support@medecins-patients.ci',
                        telephone: '+225 XX XX XX XX'
                    }
                });
            }

            // Vérifications spécifiques pour les médecins
            if (user.role === 'MEDECIN') {
                if (!user.medecin) {
                    console.log(`❌ Profil médecin manquant pour: ${email}`);
                    return ApiResponse.serverError(res, 'Erreur de configuration du compte médecin');
                }

                // Vérifier le statut de validation du médecin
                if (user.medecin.statutValidation !== 'VALIDE') {
                    console.log(`❌ Médecin non validé: ${email} - Statut: ${user.medecin.statutValidation}`);

                    let message = '';
                    let nextSteps = [];

                    switch (user.medecin.statutValidation) {
                        case 'EN_ATTENTE':
                            message = 'Votre compte médecin est en cours de validation par notre équipe.';
                            nextSteps = [
                                'Validation en cours par l\'administration',
                                'Délai estimé: 24-48 heures',
                                'Vous recevrez un email de confirmation',
                                'Contact: validation@medecins-patients.ci'
                            ];
                            break;
                        case 'REJETE':
                            message = 'Votre demande de validation a été rejetée.';
                            nextSteps = [
                                'Contactez l\'administration pour plus d\'informations',
                                'Motif du rejet: ' + (user.medecin.motifRejet || 'Non spécifié'),
                                'Email: validation@medecins-patients.ci'
                            ];
                            break;
                    }

                    return ApiResponse.forbidden(res, message, {
                        statutValidation: user.medecin.statutValidation,
                        motifRejet: user.medecin.motifRejet,
                        nextSteps,
                        contact: {
                            email: 'validation@medecins-patients.ci',
                            telephone: '+225 XX XX XX XX'
                        }
                    });
                }
            }

            // Générer les tokens JWT
            const accessToken = TokenService.generateToken(user);
            const refreshToken = TokenService.generateRefreshToken(user);

            console.log(`✅ Connexion réussie: ${user.prenom} ${user.nom} (${user.role}) - ${email}`);

            // Réponse simplifiée avec juste les tokens
            return ApiResponse.success(res, 'Connexion réussie', {
                tokens: {
                    accessToken,
                    refreshToken,
                    expiresIn: Consts.JWT_EXPIRATION[user.role]?.access || '1d'
                },
                sessionInfo: {
                    loginMethod: 'EMAIL_PASSWORD',
                    timestamp: new Date().toISOString(),
                    ip: clientIp
                }
            });

        } catch (error) {
            console.error('❌ Erreur connexion:', error);
            return ApiResponse.serverError(res, 'Erreur interne lors de la connexion');
        }
    }
);

module.exports = router;