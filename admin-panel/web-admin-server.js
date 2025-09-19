// Servidor web para el panel de administración con MySQL

const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

// Importar funciones de base de datos
const {
    db,
    cargarGrupos,
    obtenerTodosLosAutorizados,
    obtenerIdentificadoresPendientes,
    contarIdentificadoresPendientes,
    eliminarIdentificadorRemitente,
    limpiarCURPsExpiradas,
    generarEstadisticas,
    autorizarUsuario,
    desautorizarUsuario,
    autorizarGrupo,
    desautorizarGrupo,
    esAdmin,
    obtenerAdministradores,
    agregarAdministrador,
    removerAdministrador,
    obtenerConfiguracionEspecial,
    actualizarConfiguracionEspecial,
    debeUsarEnmarcadoAutomatico,
    debeSubirApiAutomatico
} = require('../whatsapp-bot/database');

const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'templates')));

// Función auxiliar para formatear números
function formatearNumero(numero) {
    if (!numero) return "Desconocido";
    const numeroLimpio = numero.split('@')[0];
    return `+${numeroLimpio}`;
}

function esGrupo(remitente) {
    return remitente && remitente.endsWith('@g.us');
}

// ==================== RUTAS PARA TEMPLATES ====================

// Ruta principal del panel admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'admin', 'dashboard_simple.html'));
});

// Ruta para CURPs pendientes
app.get('/admin/curp-pendientes', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'admin', 'curp_pendientes.html'));
});

// ==================== API ENDPOINTS ====================

// **ENDPOINT DE DEBUG PARA DIAGNOSTICAR PROBLEMAS**
app.get('/admin/api/debug', async (req, res) => {
    try {
        console.log('🔧 DEBUG: Verificando estado de la base de datos...');
        
        // Probar conexión a la base de datos
        const testQuery = await db.query('SELECT 1 as test');
        console.log('✅ Conexión DB OK:', testQuery);
        
        // Probar cada función individualmente
        let autorizados, administradores;
        
        try {
            autorizados = await obtenerTodosLosAutorizados();
            console.log('✅ obtenerTodosLosAutorizados OK:', autorizados ? autorizados.length : 'null');
        } catch (error) {
            console.error('❌ Error en obtenerTodosLosAutorizados:', error.message);
            autorizados = null;
        }
        
        try {
            administradores = await obtenerAdministradores();
            console.log('✅ obtenerAdministradores OK:', administradores ? administradores.length : 'null');
        } catch (error) {
            console.error('❌ Error en obtenerAdministradores:', error.message);
            administradores = null;
        }
        
        res.json({
            success: true,
            debug_info: {
                database_connection: 'OK',
                autorizados_result: autorizados ? `Array con ${autorizados.length} elementos` : 'null o error',
                administradores_result: administradores ? `Array con ${administradores.length} elementos` : 'null o error',
                raw_autorizados: autorizados,
                raw_administradores: administradores
            }
        });
        
    } catch (error) {
        console.error('❌ Error en debug:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// ==================== API ENDPOINTS ====================

// **AGREGAR ESTE ENDPOINT QUE FALTABA**
app.get('/admin/api/authorized', async (req, res) => {
    try {
        console.log('🔍 Obteniendo usuarios autorizados con configuración especial...');
        
        let autorizados = [];
        let administradores = [];
        
        try {
            autorizados = await obtenerTodosLosAutorizados() || [];
        } catch (error) {
            console.error('Error obteniendo autorizados:', error);
            autorizados = [];
        }
        
        try {
            administradores = await obtenerAdministradores() || [];
        } catch (error) {
            console.error('Error obteniendo administradores:', error);
            administradores = [];
        }

        // Asegurar que sean arrays
        if (!Array.isArray(autorizados)) autorizados = [];
        if (!Array.isArray(administradores)) administradores = [];

        // Procesar usuarios autorizados CON configuración especial
        const usuarios_autorizados = autorizados
            .filter(a => a && a.tipo_remitente === 'usuario')
            .map(u => ({
                id: u.remitente_id || '',
                nombre: formatearNumero(u.remitente_id || ''),
                fecha_autorizacion: u.fecha_autorizacion || null,
                // AGREGAR CONFIGURACIÓN ESPECIAL:
                enmarcado_automatico: Boolean(u.enmarcado_automatico),
                subir_api_automatico: Boolean(u.subir_api_automatico),
                configurado_por: u.configurado_por || null,
                fecha_configuracion: u.fecha_configuracion || null
            }));

        // Procesar grupos autorizados CON configuración especial
        const grupos_autorizados = autorizados
            .filter(a => a && a.tipo_remitente === 'grupo')
            .map(g => ({
                id: g.remitente_id || '',
                nombre: g.nombre_grupo || `Grupo: ${formatearNumero(g.remitente_id || '')}`,
                participantes: 'N/A',
                fecha_autorizacion: g.fecha_autorizacion || null,
                // AGREGAR CONFIGURACIÓN ESPECIAL:
                enmarcado_automatico: Boolean(g.enmarcado_automatico),
                subir_api_automatico: Boolean(g.subir_api_automatico),
                configurado_por: g.configurado_por || null,
                fecha_configuracion: g.fecha_configuracion || null
            }));

        // Formatear administradores (sin cambios)
        const administradores_formateados = administradores
            .filter(admin => admin && admin.remitente_id)
            .map(admin => ({
                id: admin.remitente_id,
                nombre: admin.nombre || 'Admin sin nombre',
                tipo: admin.tipo_remitente || 'usuario',
                fecha_creacion: admin.fecha_creacion || null,
                numero_formateado: formatearNumero(admin.remitente_id)
            }));

        console.log(`✅ Datos obtenidos: ${usuarios_autorizados.length} usuarios, ${grupos_autorizados.length} grupos, ${administradores_formateados.length} admins`);

        // Respuesta con estructura que coincide con el frontend
        const response = {
            success: true,
            // Nombres que espera el frontend
            usuarios: usuarios_autorizados,
            grupos: grupos_autorizados,
            administradores: administradores_formateados,
            // También mantener los nombres originales por compatibilidad
            usuarios_autorizados: usuarios_autorizados,
            grupos_autorizados: grupos_autorizados,
            total_autorizados: usuarios_autorizados.length + grupos_autorizados.length,
            total_administradores: administradores_formateados.length,
            timestamp: new Date().toISOString()
        };

        res.json(response);
        
    } catch (error) {
        console.error('❌ Error crítico en /admin/api/authorized:', error);
        
        const errorResponse = {
            success: false,
            error: error.message || 'Error desconocido',
            usuarios: [],
            grupos: [],
            administradores: [],
            usuarios_autorizados: [],
            grupos_autorizados: [],
            total_autorizados: 0,
            total_administradores: 0,
            timestamp: new Date().toISOString()
        };
        
        res.status(500).json(errorResponse);
    }
});
// Estado del sistema
app.get('/admin/api/status', async (req, res) => {
    try {
        res.json({
            success: true,
            flask: {
                running: true,
                pid: process.pid,
                memory_usage: process.memoryUsage().heapUsed / 1024 / 1024
            },
            whatsapp_bot: {
                running: global.client ? true : false,
                pid: process.pid,
                memory_usage: process.memoryUsage().heapUsed / 1024 / 1024
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Información del sistema
app.get('/admin/api/system-info', async (req, res) => {
    try {
        const memoryUsage = process.memoryUsage();
        const autorizados = await obtenerTodosLosAutorizados();

        res.json({
            success: true,
            sistema: {
                cpu_percent: Math.random() * 100,
                memory_percent: (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100
            },
            archivos: {
                usuarios_autorizados: autorizados.filter(a => a.tipo_remitente === 'usuario').length,
                grupos_autorizados: autorizados.filter(a => a.tipo_remitente === 'grupo').length
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Estadísticas
app.get('/admin/api/statistics', async (req, res) => {
    try {
        const estadisticas = await db.query(`
            SELECT 
                SUM(total_documentos) as total_documentos,
                COUNT(*) as total_usuarios
            FROM contadores
        `);

        const detalladas = await db.query(`
            SELECT 
                nombre_remitente as nombre,
                CASE 
                    WHEN remitente_id LIKE '%@g.us' THEN 'Grupo'
                    ELSE 'Usuario'
                END as tipo,
                total_documentos as documentos
            FROM contadores
            ORDER BY total_documentos DESC
            LIMIT 10
        `);

        res.json({
            success: true,
            total_documentos: estadisticas[0]?.total_documentos || 0,
            total_usuarios: estadisticas[0]?.total_usuarios || 0,
            estadisticas_detalladas: detalladas
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener pendientes (usuarios no autorizados que han enviado solicitudes)
app.get('/admin/api/pending', async (req, res) => {
    try {
        const pendientes = await db.query(`
            SELECT DISTINCT s.remitente_id, s.nombre_remitente
            FROM solicitudes s
            LEFT JOIN autorizaciones a ON s.remitente_id = a.remitente_id AND a.autorizado = true
            WHERE s.autorizado = false AND a.remitente_id IS NULL
            ORDER BY s.fecha_solicitud DESC
        `);

        const usuarios_pendientes = pendientes
            .filter(p => !esGrupo(p.remitente_id))
            .map(u => ({
                id: u.remitente_id,
                nombre: u.nombre_remitente || formatearNumero(u.remitente_id)
            }));

        const grupos_pendientes = pendientes
            .filter(p => esGrupo(p.remitente_id))
            .map(g => ({
                id: g.remitente_id,
                nombre: g.nombre_remitente || `Grupo: ${formatearNumero(g.remitente_id)}`,
                participantes: 'N/A'
            }));

        res.json({
            success: true,
            usuarios_pendientes,
            grupos_pendientes
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener CURPs pendientes
app.get('/admin/api/curp-pendientes', async (req, res) => {
    try {
        const pendientes = await obtenerIdentificadoresPendientes();

        const pendientesFormateados = pendientes.map(item => ({
            identificador: item.identificador,
            remitente_id: item.remitente_id,
            remitente_nombre: item.nombre_grupo || formatearNumero(item.remitente_id),
            tipo_remitente: esGrupo(item.remitente_id) ? 'Grupo' : 'Usuario',
            tipo_acta: item.tipo_acta,
            solicita_marco: item.solicita_marco,
            solicita_folio: item.solicita_folio,
            es_grupo_auto_marco: item.es_grupo_auto_marco,
            intentos: item.intentos,
            tiempo_transcurrido_min: item.minutos_transcurridos
        }));

        res.json({
            success: true,
            pendientes: pendientesFormateados
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eliminar CURP pendiente
app.post('/admin/api/eliminar-curp-pendiente', async (req, res) => {
    try {
        const { identificador, notificar = true } = req.body;

        if (!identificador) {
            return res.status(400).json({ success: false, error: 'Identificador requerido' });
        }

        // ✅ OBTENER DATOS DEL REMITENTE ORIGINAL (quien hizo la solicitud)
        const datosRemitente = await db.query(`
            SELECT remitente_id, tipo_acta 
            FROM identificador_remitente 
            WHERE identificador = ?
        `, [identificador]);

        if (datosRemitente.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'CURP no encontrada'
            });
        }

        const { remitente_id, tipo_acta } = datosRemitente[0];
        const eliminado = await eliminarIdentificadorRemitente(identificador);

        if (eliminado) {
            if (notificar) {
                const fs = require('fs');
                const path = require('path');

                const mensajeNotificacion = `❌ *Documento no encontrado*\n\nLa ${tipo_acta} con CURP/código: *${identificador}* no fue encontrada en los registros.\n\nPor favor verifica los datos e intenta nuevamente.`;

                // ✅ CREAR NOTIFICACIÓN PARA EL REMITENTE ORIGINAL
                const notificacion = {
                    destinatario: remitente_id,  // ⬅️ CORRECCIÓN: Enviar al usuario original
                    mensaje: mensajeNotificacion,
                    identificador: identificador,
                    timestamp: new Date().toISOString(),
                    procesado: false
                };

                const archivoTemp = path.join(__dirname, '..', `notif_temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.json`);
                fs.writeFileSync(archivoTemp, JSON.stringify(notificacion, null, 2));
                
                console.log(`📱 Notificación creada para remitente original ${remitente_id}: ${identificador} no encontrado`);
                
                // ✅ OPCIONAL: También notificar a administradores para log interno
                const administradoresActivos = await obtenerAdministradores();
                if (administradoresActivos && administradoresActivos.length > 0) {
                    const mensajeAdmin = `🗑️ *CURP eliminada del panel*\n\nIdentificador: ${identificador}\nRemitente original: ${remitente_id}\nRazón: Documento no encontrado\n\nEl usuario ha sido notificado.`;
                    
                    for (const admin of administradoresActivos) {
                        const notificacionAdmin = {
                            destinatario: admin.remitente_id,
                            mensaje: mensajeAdmin,
                            identificador: `admin_log_${identificador}`,
                            timestamp: new Date().toISOString(),
                            procesado: false
                        };

                        const archivoTempAdmin = path.join(__dirname, '..', `notif_temp_admin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.json`);
                        fs.writeFileSync(archivoTempAdmin, JSON.stringify(notificacionAdmin, null, 2));
                        
                        // Pequeño delay para evitar conflictos
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                    console.log(`📋 Log enviado a administradores sobre eliminación de ${identificador}`);
                }
            }

            res.json({
                success: true,
                message: `CURP ${identificador} eliminada exitosamente${notificar ? ' y usuario original notificado' : ''}`
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'CURP no encontrada'
            });
        }
    } catch (error) {
        console.error('Error eliminando CURP:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// Limpiar CURPs expiradas
app.post('/admin/api/limpiar-curps-expiradas', async (req, res) => {
    try {
        const antes = await contarIdentificadoresPendientes();
        const eliminadas = await limpiarCURPsExpiradas();
        const despues = await contarIdentificadoresPendientes();

        res.json({
            success: true,
            message: 'Limpieza completada',
            eliminadas,
            mantenidas: despues
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Autorizar usuario/grupo
app.post('/admin/api/authorize', async (req, res) => {
    try {
        const { id, type } = req.body;

        if (!id || !type) {
            return res.status(400).json({ success: false, error: 'ID y tipo requeridos' });
        }

        const esAdminResult = await esAdmin(id);
        if (esAdminResult) {
            return res.status(400).json({
                success: false,
                error: 'No se puede autorizar a un administrador. Los administradores tienen acceso automático.'
            });
        }

        let resultado;
        if (type === 'user') {
            resultado = await autorizarUsuario(id, 'PANEL_WEB');
        } else if (type === 'group') {
            resultado = await autorizarGrupo(id, 'PANEL_WEB');
        } else {
            return res.status(400).json({ success: false, error: 'Tipo inválido' });
        }

        if (resultado) {
            res.json({
                success: true,
                message: `${type === 'user' ? 'Usuario' : 'Grupo'} autorizado exitosamente`
            });
        } else {
            res.json({
                success: true,
                message: `${type === 'user' ? 'Usuario' : 'Grupo'} ya estaba autorizado`
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Revocar autorización
app.post('/admin/api/revoke', async (req, res) => {
    try {
        const { id, type } = req.body;

        if (!id || !type) {
            return res.status(400).json({ success: false, error: 'ID y tipo requeridos' });
        }

        let resultado;
        if (type === 'user') {
            resultado = await desautorizarUsuario(id);
        } else if (type === 'group') {
            resultado = await desautorizarGrupo(id);
        } else {
            return res.status(400).json({ success: false, error: 'Tipo inválido' });
        }

        if (resultado) {
            res.json({
                success: true,
                message: `Autorización de ${type === 'user' ? 'usuario' : 'grupo'} revocada exitosamente`
            });
        } else {
            res.status(404).json({
                success: false,
                error: `${type === 'user' ? 'Usuario' : 'Grupo'} no encontrado en autorizados`
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener lista de administradores
app.get('/admin/api/administrators', async (req, res) => {
    try {
        const administradores = await obtenerAdministradores();

        const administradoresFormateados = administradores.map(admin => ({
            id: admin.remitente_id,
            nombre: admin.nombre,
            tipo: admin.tipo_remitente,
            fecha_creacion: admin.fecha_creacion,
            numero_formateado: formatearNumero(admin.remitente_id)
        }));

        res.json({
            success: true,
            administradores: administradoresFormateados,
            total: administradoresFormateados.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Agregar nuevo administrador
app.post('/admin/api/add-administrator', async (req, res) => {
    try {
        const { remitente_id, nombre, tipo_remitente } = req.body;

        if (!remitente_id || !nombre) {
            return res.status(400).json({
                success: false,
                error: 'ID de remitente y nombre son requeridos'
            });
        }

        const tipo = tipo_remitente || (remitente_id.endsWith('@g.us') ? 'grupo' : 'usuario');
        const resultado = await agregarAdministrador(remitente_id, nombre, tipo, 'PANEL_WEB');

        if (resultado.success) {
            res.json({
                success: true,
                message: `Administrador ${nombre} agregado exitosamente`
            });
        } else {
            res.status(400).json({
                success: false,
                error: resultado.message
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Remover administrador
app.post('/admin/api/remove-administrator', async (req, res) => {
    try {
        const { remitente_id } = req.body;

        if (!remitente_id) {
            return res.status(400).json({
                success: false,
                error: 'ID de remitente requerido'
            });
        }

        const resultado = await removerAdministrador(remitente_id, 'PANEL_WEB');

        if (resultado.success) {
            res.json({
                success: true,
                message: 'Administrador removido exitosamente'
            });
        } else {
            res.status(400).json({
                success: false,
                error: resultado.message
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Logs del sistema
app.get('/admin/api/logs', async (req, res) => {
    try {
        const logs = [
            {
                timestamp: new Date().toISOString(),
                type: 'info',
                message: 'Sistema iniciado correctamente'
            },
            {
                timestamp: new Date(Date.now() - 60000).toISOString(),
                type: 'success',
                message: 'Conexión a MySQL establecida'
            },
            {
                timestamp: new Date(Date.now() - 120000).toISOString(),
                type: 'warning',
                message: 'Cola de archivos procesada'
            }
        ];

        res.json({
            success: true,
            logs
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para actualizar configuración especial de usuario
app.post('/admin/api/update-special-config', async (req, res) => {
    try {
        const { remitente_id, enmarcado_automatico, subir_api_automatico } = req.body;
        
        if (!remitente_id) {
            return res.status(400).json({
                success: false,
                error: 'ID de remitente requerido'
            });
        }
        
        console.log(`Actualizando configuración especial para ${remitente_id}:`, {
            enmarcado_automatico: Boolean(enmarcado_automatico),
            subir_api_automatico: Boolean(subir_api_automatico)
        });
        
        const resultado = await actualizarConfiguracionEspecial(
            remitente_id,
            Boolean(enmarcado_automatico),
            Boolean(subir_api_automatico),
            'PANEL_WEB'
        );
        
        if (resultado.success) {
            res.json({
                success: true,
                message: resultado.message
            });
        } else {
            res.status(400).json({
                success: false,
                error: resultado.message
            });
        }
        
    } catch (error) {
        console.error('Error actualizando configuración especial:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== INICIALIZACIÓN ====================

async function iniciarServidor() {
    try {
        const dbConnected = await db.init();
        if (!dbConnected) {
            console.error('❌ No se pudo conectar a la base de datos');
            process.exit(1);
        }

        console.log('✅ Base de datos conectada para panel admin');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🌐 Servidor de administración iniciado en http://localhost:${PORT}`);
            console.log(`📊 Panel admin: http://localhost:${PORT}/admin`);
            console.log(`📋 CURPs pendientes: http://localhost:${PORT}/admin/curp-pendientes`);
        });

    } catch (error) {
        console.error('❌ Error iniciando servidor:', error);
        process.exit(1);
    }
}

// Iniciar servidor
iniciarServidor();


module.exports = app;
