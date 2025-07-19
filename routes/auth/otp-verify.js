const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const ApiResponse = require('../../services/ApiResponse');
const TokenService = require('../../services/TokenService');
const BodyFilter = require('../../middleware/bodyFilterMiddleware');
const Consts = require('../../config/const');

// Schéma de validation
const otpVerifySchema = {
    fields: {
        telephone: {
            type: 'phone'
        },
        otp: {
            type: 'string',
            minLength: 4,
            maxLength: 4,
            pattern: '^[0-9]{4}$'
        }
    },
    required: ['telephone', 'otp'],
    strict: true
};

/**
 * POST /auth/otp/verify - Vérification du code OTP
 * - Si patient existant : connexion automatique avec tokens
 * - Si autre rôle existant : vérification uniquement
 * - Si utilisateur inexistant : vérification uniquement
 */
router.post('/',
    BodyFilter.validate(otpVerifySchema),
    async (req, res) => {
        try {
            const { telephone, otp } = req.body;
            const clientIp = req.ip || req.connection.remoteAddress;

            console.log(`🔐 Vérification OTP pour: ${telephone} - Code: ${otp} - IP: ${clientIp}`);

            // Nettoyage du numéro
            const cleanPhone = telephone.replace(/[^0-9]/g, '');

            // Recherche du code OTP valide
            const otpRecord = await prisma.otp.findFirst({
                where: {
                    telephone: cleanPhone,
                    code: otp,
                    utilise: false,
                    expiresAt: {
                        gt: new Date()
                    }
                },
                orderBy: { createdAt: 'desc' }
            });

            if (!otpRecord) {
                // Vérifier si le code a expiré
                const expiredOtp = await prisma.otp.findFirst({
                    where: {
                        telephone: cleanPhone,
                        code: otp,
                        utilise: false
                    },
                    orderBy: { createdAt: 'desc' }
                });

                if (expiredOtp) {
                    console.log(`⏰ Code OTP expiré pour ${cleanPhone}`);
                    return ApiResponse.badRequest(res, 'Code de vérification expiré', {
                        code: 'OTP_EXPIRED',
                        message: 'Le code de vérification a expiré. Veuillez demander un nouveau code.'
                    });
                }

                // Incrémenter les tentatives si l'OTP existe
                await prisma.otp.updateMany({
                    where: {
                        telephone: cleanPhone,
                        utilise: false
                    },
                    data: {
                        tentatives: {
                            increment: 1
                        }
                    }
                });

                console.log(`❌ Code OTP invalide pour ${cleanPhone}: ${otp}`);
                return ApiResponse.badRequest(res, 'Code de vérification invalide', {
                    code: 'OTP_INVALID',
                    message: 'Le code de vérification est incorrect. Veuillez vérifier et réessayer.'
                });
            }

            // Vérifier le nombre de tentatives
            if (otpRecord.tentatives >= Consts.OTP_CONFIG.maxAttempts) {
                // Marquer comme utilisé pour bloquer
                await prisma.otp.update({
                    where: { id: otpRecord.id },
                    data: { utilise: true }
                });

                console.log(`🚫 Trop de tentatives pour ${cleanPhone}`);
                return ApiResponse.badRequest(res, 'Trop de tentatives', {
                    code: 'OTP_MAX_ATTEMPTS',
                    message: 'Trop de tentatives incorrectes. Veuillez demander un nouveau code.'
                });
            }

            // Marquer l'OTP comme utilisé
            await prisma.otp.update({
                where: { id: otpRecord.id },
                data: { utilise: true }
            });

            // Vérifier si l'utilisateur existe déjà
            const existingUser = await prisma.user.findUnique({
                where: { telephone: cleanPhone },
                include: {
                    patient: true,
                    medecin: {
                        include: {
                            clinique: true
                        }
                    }
                }
            });

            console.log(`✅ Code OTP vérifié avec succès pour ${cleanPhone}`);

            // CAS 1: PATIENT EXISTANT → CONNEXION AUTOMATIQUE AVEC TOKENS
            if (existingUser && existingUser.role === 'PATIENT') {
                // Vérifier que le compte est actif
                if (existingUser.statut !== 'ACTIF') {
                    console.log(`🚫 Patient inactif: ${existingUser.id} - Statut: ${existingUser.statut}`);
                    return ApiResponse.forbidden(res, 'Compte patient suspendu ou désactivé', {
                        statut: existingUser.statut,
                        message: 'Votre compte patient est actuellement suspendu. Contactez le support.'
                    });
                }

                // Générer les tokens JWT pour le patient
                const accessToken = TokenService.generateToken(existingUser);
                const refreshToken = TokenService.generateRefreshToken(existingUser);

                const patientInfo = {
                    id: existingUser.id,
                    telephone: existingUser.telephone,
                    email: existingUser.email,
                    nom: existingUser.nom,
                    prenom: existingUser.prenom,
                    role: existingUser.role,
                    statut: existingUser.statut,
                    patient: existingUser.patient ? {
                        id: existingUser.patient.id,
                        dateNaissance: existingUser.patient.dateNaissance,
                        sexe: existingUser.patient.sexe,
                        ville: existingUser.patient.ville
                    } : null
                };

                console.log(`🎯 Connexion automatique patient: ${existingUser.prenom} ${existingUser.nom}`);

                return ApiResponse.success(res, 'Connexion réussie', {
                    authType: 'PATIENT_LOGIN',
                    user: patientInfo,
                    tokens: {
                        accessToken,
                        refreshToken,
                        expiresIn: Consts.JWT_EXPIRATION.PATIENT.access
                    },
                    sessionInfo: {
                        ip: clientIp,
                        timestamp: new Date().toISOString(),
                        loginMethod: 'OTP'
                    }
                });
            }

            // CAS 2: MÉDECIN/ADMIN EXISTANT → VÉRIFICATION UNIQUEMENT (PAS DE TOKENS)
            if (existingUser && (existingUser.role === 'MEDECIN' || existingUser.role === 'ADMIN')) {
                let nextStepsMessage = [];

                if (existingUser.role === 'MEDECIN') {
                    nextStepsMessage = [
                        'Utilisez votre email et mot de passe pour vous connecter',
                        'Endpoint: POST /v1/auth/login'
                    ];
                } else if (existingUser.role === 'ADMIN') {
                    nextStepsMessage = [
                        'Utilisez vos identifiants administrateur pour vous connecter',
                        'Endpoint: POST /v1/auth/login'
                    ];
                }

                return ApiResponse.success(res, 'Numéro vérifié avec succès', {
                    authType: 'VERIFICATION_ONLY',
                    telephone: cleanPhone,
                    isValidated: true,
                    userExists: true,
                    userInfo: {
                        id: existingUser.id,
                        telephone: existingUser.telephone,
                        nom: existingUser.nom,
                        prenom: existingUser.prenom,
                        role: existingUser.role,
                        statut: existingUser.statut
                    },
                    nextSteps: nextStepsMessage,
                    validationInfo: {
                        validatedAt: new Date().toISOString(),
                        ip: clientIp,
                        validUntil: new Date(Date.now() + (10 * 60 * 1000)).toISOString()
                    }
                });
            }

            // CAS 3: UTILISATEUR INEXISTANT → VÉRIFICATION UNIQUEMENT
            return ApiResponse.success(res, 'Numéro vérifié avec succès', {
                authType: 'VERIFICATION_ONLY',
                telephone: cleanPhone,
                isValidated: true,
                userExists: false,
                userInfo: null,
                nextSteps: [
                    'Votre numéro est vérifié',
                    'Vous pouvez maintenant créer votre compte patient',
                    'Endpoint: POST /v1/auth/register/patient'
                ],
                validationInfo: {
                    validatedAt: new Date().toISOString(),
                    ip: clientIp,
                    validUntil: new Date(Date.now() + (10 * 60 * 1000)).toISOString()
                }
            });

        } catch (error) {
            console.error('❌ Erreur vérification OTP:', error);
            return ApiResponse.serverError(res, 'Erreur interne lors de la vérification');
        }
    }
);

module.exports = router;