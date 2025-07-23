const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const ApiResponse = require('../../services/ApiResponse');
const AuthMiddleware = require('../../middleware/authMiddleware');

/**
 * POST /auth/logout - Déconnexion globale de l'utilisateur
 */
router.post('/',
    AuthMiddleware.authenticate(),
    async (req, res) => {
        try {
            const user = req.user;
            const clientIp = req.ip || req.connection.remoteAddress;

            console.log(`🚪 Déconnexion demandée pour: ${user.prenom} ${user.nom} (${user.role}) - IP: ${clientIp}`);

            // Révocation de tous les tokens actifs de l'utilisateur
            const revokedTokens = await prisma.userToken.updateMany({
                where: {
                    userId: user.id,
                    typeToken: {
                        in: ['ACCESS', 'REFRESH']
                    },
                    utilise: false,
                    dateExpiration: {
                        gt: new Date()
                    }
                },
                data: {
                    utilise: true
                }
            });

            console.log(`✅ Déconnexion réussie: ${user.prenom} ${user.nom} - ${revokedTokens.count} tokens révoqués`);

            // Réponse de confirmation
            return ApiResponse.success(res, 'Déconnexion réussie', {
                logoutInfo: {
                    userId: user.id,
                    userRole: user.role,
                    tokensRevoked: revokedTokens.count,
                    logoutTime: new Date().toISOString(),
                    ip: clientIp
                },
                securityInfo: {
                    message: 'Tous vos tokens d\'accès ont été révoqués',
                    action: 'Vous devez vous reconnecter pour accéder à nouveau à l\'application',
                    affectedDevices: 'Tous les appareils connectés'
                },
                nextSteps: [
                    'Reconnectez-vous avec vos identifiants',
                    'Vos sessions sur tous les appareils ont été fermées',
                    'Cette action améliore la sécurité de votre compte'
                ]
            });

        } catch (error) {
            console.error('❌ Erreur déconnexion:', error);
            return ApiResponse.serverError(res, 'Erreur interne lors de la déconnexion');
        }
    }
);

module.exports = router;