// database.js - Módulo completo de MySQL para WhatsApp Bot
const mysql = require('mysql2/promise');

class DatabaseManager {
    constructor() {
        this.pool = null;
        this.isConnected = false;
    }

    async init() {
        try {
            this.pool = mysql.createPool({
                host: process.env.MYSQL_HOST,
                port: process.env.DB_PORT,
                user: process.env.MYSQL_USER,
                password: process.env.MYSQL_PASSWORD,
                database: process.env.MYSQL_DATABASE,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0
            });

            const connection = await this.pool.getConnection();
            await connection.ping();
            connection.release();

            this.isConnected = true;
            console.log('✅ Conexión a MySQL establecida');
            return true;
        } catch (error) {
            console.error('❌ Error conectando a MySQL:', error.message);
            this.isConnected = false;
            return false;
        }
    }

    async query(sql, params = []) {
        if (!this.isConnected || !this.pool) {
            throw new Error('Base de datos no conectada');
        }

        try {
            const [rows] = await this.pool.execute(sql, params);
            return rows;
        } catch (error) {
            console.error('❌ Error en query:', error.message);
            console.error('SQL:', sql);
            console.error('Params:', params);
            throw error;
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            this.isConnected = false;
            console.log('🔌 Conexión MySQL cerrada');
        }
    }
}

// Instancia singleton
const db = new DatabaseManager();

// Funciones auxiliares
function esGrupo(remitente) {
    return remitente && remitente.endsWith('@g.us');
}

function formatearNumero(numero) {
    if (!numero) return "Desconocido";
    const numeroLimpio = numero.split('@')[0];
    return `+${numeroLimpio}`;
}

// ===== FUNCIONES PARA GESTIÓN DE GRUPOS =====

async function cargarGrupos() {
    try {
        const sql = 'SELECT id, nombre, participantes, fecha_registro FROM grupos';
        const grupos = await db.query(sql);
        console.log(`Grupos cargados desde MySQL: ${grupos.length} grupos registrados`);
        return grupos;
    } catch (error) {
        console.error('Error al cargar grupos desde MySQL:', error);
        return [];
    }
}

async function guardarGrupo(grupoId, nombre, participantes = 0) {
    try {
        const sql = `
            INSERT INTO grupos (id, nombre, participantes, fecha_registro) 
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE 
                nombre = VALUES(nombre),
                participantes = VALUES(participantes),
                fecha_actualizacion = NOW()
        `;

        await db.query(sql, [grupoId, nombre, participantes]);
        console.log(`Grupo guardado en MySQL: "${nombre}" (${participantes} participantes)`);
        return true;
    } catch (error) {
        console.error('Error al guardar grupo en MySQL:', error);
        return false;
    }
}

async function getNombreGrupo(remitente) {
    try {
        if (!esGrupo(remitente)) {
            return formatearNumero(remitente);
        }

        const sql = 'SELECT nombre FROM grupos WHERE id = ?';
        const resultado = await db.query(sql, [remitente]);

        if (resultado.length > 0 && resultado[0].nombre) {
            return resultado[0].nombre;
        }

        return `Grupo: ${formatearNumero(remitente)}`;
    } catch (error) {
        console.error(`Error al obtener nombre de grupo ${remitente}:`, error);
        return `Grupo: ${formatearNumero(remitente)}`;
    }
}

async function detectarYRegistrarGrupo(sock, remitente) {
    if (!esGrupo(remitente)) return false;

    try {
        const sqlCheck = 'SELECT id, nombre FROM grupos WHERE id = ?';
        const grupoExistente = await db.query(sqlCheck, [remitente]);

        if (grupoExistente.length > 0 && grupoExistente[0].nombre) {
            return true;
        }

        console.log(`Detectando información del grupo: ${remitente}`);
        const groupMetadata = await sock.groupMetadata(remitente);

        if (groupMetadata && groupMetadata.subject) {
            const exito = await guardarGrupo(
                remitente,
                groupMetadata.subject,
                groupMetadata.participants?.length || 0
            );
            return exito;
        }
        return false;
    } catch (error) {
        console.error(`Error al detectar/registrar grupo ${remitente}:`, error);
        return false;
    }
}

// ===== FUNCIONES PARA GESTIÓN DE AUTORIZACIONES =====

async function estaAutorizado(remitente) {
    try {
        const ADMINS = [
            '5219541594944@s.whatsapp.net',
            '5219541288669@s.whatsapp.net',
            '5218147960123@s.whatsapp.net'
        ];

        if (ADMINS.includes(remitente)) {
            return true;
        }

        const sql = `
            SELECT autorizado 
            FROM autorizaciones 
            WHERE remitente_id = ? AND autorizado = true
        `;
        const resultado = await db.query(sql, [remitente]);

        return resultado.length > 0;
    } catch (error) {
        console.error(`Error verificando autorización para ${remitente}:`, error);
        return false;
    }
}

async function autorizarUsuario(usuario, autorizadoPor = 'ADMIN') {
    try {
        const tipoRemitente = usuario.endsWith('@g.us') ? 'grupo' : 'usuario';

        const sql = `
            INSERT INTO autorizaciones (remitente_id, tipo_remitente, autorizado, autorizado_por)
            VALUES (?, ?, true, ?)
            ON DUPLICATE KEY UPDATE 
                autorizado = true,
                autorizado_por = VALUES(autorizado_por),
                fecha_autorizacion = NOW()
        `;

        const resultado = await db.query(sql, [usuario, tipoRemitente, autorizadoPor]);
        const esNuevo = resultado.insertId > 0;

        console.log(`Usuario ${esNuevo ? 'autorizado' : 'ya estaba autorizado'}: ${usuario}`);
        return esNuevo;
    } catch (error) {
        console.error(`Error al autorizar usuario ${usuario}:`, error);
        return false;
    }
}

async function desautorizarUsuario(usuario) {
    try {
        const sql = `UPDATE autorizaciones SET autorizado = false WHERE remitente_id = ?`;
        const resultado = await db.query(sql, [usuario]);

        const seDesautorizo = resultado.affectedRows > 0;
        console.log(`Usuario ${seDesautorizo ? 'desautorizado' : 'no encontrado'}: ${usuario}`);
        return seDesautorizo;
    } catch (error) {
        console.error(`Error al desautorizar usuario ${usuario}:`, error);
        return false;
    }
}

async function autorizarGrupo(grupo, autorizadoPor = 'ADMIN') {
    return await autorizarUsuario(grupo, autorizadoPor);
}

async function desautorizarGrupo(grupo) {
    return await desautorizarUsuario(grupo);
}

async function obtenerTodosLosAutorizados() {
    try {
        const sql = `
            SELECT 
                a.remitente_id,
                a.tipo_remitente,
                a.fecha_autorizacion,
                a.autorizado_por,
                a.enmarcado_automatico,
                a.subir_api_automatico,
                a.configurado_por,
                a.fecha_configuracion,
                g.nombre as nombre_grupo
            FROM autorizaciones a
            LEFT JOIN grupos g ON a.remitente_id = g.id
            WHERE a.autorizado = true
            ORDER BY a.tipo_remitente, a.fecha_autorizacion
        `;
        
        const autorizados = await db.query(sql);
        return autorizados;
        
    } catch (error) {
        console.error('Error al obtener lista de autorizados:', error);
        return [];
    }
}

async function recargarAutorizaciones() {
    try {
        const usuarios = await obtenerTodosLosAutorizados();
        console.log(`Autorizaciones recargadas: ${usuarios.length} registros`);
        return usuarios;
    } catch (error) {
        console.error('Error al recargar autorizaciones:', error);
        return [];
    }
}

// ===== FUNCIONES PARA MAPA IDENTIFICADOR-REMITENTE =====

async function agregarIdentificadorRemitente(identificador, datosRemitente) {
    try {
        const sql = `
            INSERT INTO identificador_remitente 
            (identificador, remitente_id, tipo_acta, solicita_marco, solicita_folio, es_grupo_auto_marco, intentos)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                tipo_acta = VALUES(tipo_acta),
                solicita_marco = VALUES(solicita_marco),
                solicita_folio = VALUES(solicita_folio),
                es_grupo_auto_marco = VALUES(es_grupo_auto_marco),
                intentos = VALUES(intentos),
                fecha_ultimo_intento = NOW()
        `;

        await db.query(sql, [
            identificador,
            datosRemitente.remitente,
            datosRemitente.tipoActa,
            datosRemitente.solicitaMarco,
            datosRemitente.solicitaFolio,
            datosRemitente.esGrupoAutoMarco,
            datosRemitente.intentos || 0
        ]);

        console.log(`Identificador agregado: ${identificador} para ${datosRemitente.remitente}`);
        return true;
    } catch (error) {
        console.error(`Error al agregar identificador ${identificador}:`, error);
        return false;
    }
}
async function obtenerDatosRemitente(identificador) {
    try {
        console.log(`🔍 Buscando datos para identificador: ${identificador}`);

        const sql = `
            SELECT * FROM identificador_remitente 
            WHERE identificador = ?
            ORDER BY fecha_creacion DESC
            LIMIT 1
        `;

        const resultado = await db.query(sql, [identificador]);

        console.log(`📊 Resultado de búsqueda SQL:`, {
            query: sql,
            params: [identificador],
            rowsFound: resultado.length
        });

        if (resultado.length > 0) {
            const datos = resultado[0];

            console.log(`✅ Datos encontrados en MySQL:`, {
                identificador: datos.identificador,
                remitente_id: datos.remitente_id,
                tipo_acta: datos.tipo_acta,
                solicita_marco: datos.solicita_marco,
                solicita_folio: datos.solicita_folio,
                es_grupo_auto_marco: datos.es_grupo_auto_marco,
                intentos: datos.intentos,
                fecha_creacion: datos.fecha_creacion
            });

            const datosFormateados = {
                remitente: datos.remitente_id,
                tipoActa: datos.tipo_acta,
                solicitaMarco: Boolean(datos.solicita_marco), // Asegurar boolean
                solicitaFolio: Boolean(datos.solicita_folio), // Asegurar boolean  
                esGrupoAutoMarco: Boolean(datos.es_grupo_auto_marco), // Asegurar boolean
                timestamp: datos.fecha_creacion.getTime(),
                intentos: datos.intentos
            };

            console.log(`🔧 Datos formateados para retorno:`, datosFormateados);
            return datosFormateados;
        }

        console.log(`❌ No se encontraron datos para identificador: ${identificador}`);
        return null;
    } catch (error) {
        console.error(`❌ Error al obtener datos para ${identificador}:`, error);
        console.error(`Stack trace:`, error.stack);
        return null;
    }
}

// También agregar función de debug para verificar toda la tabla
async function debugIdentificadorRemitente() {
    try {
        console.log('🔍 === DEBUG: Contenido tabla identificador_remitente ===');

        const sqlCount = 'SELECT COUNT(*) as total FROM identificador_remitente';
        const count = await db.query(sqlCount);
        console.log(`📊 Total registros en tabla: ${count[0].total}`);

        if (count[0].total > 0) {
            const sqlAll = `
                SELECT identificador, remitente_id, tipo_acta, solicita_marco, solicita_folio, 
                       es_grupo_auto_marco, intentos, fecha_creacion
                FROM identificador_remitente 
                ORDER BY fecha_creacion DESC 
                LIMIT 10
            `;

            const registros = await db.query(sqlAll);
            console.log('📋 Últimos 10 registros:');
            registros.forEach((registro, index) => {
                console.log(`${index + 1}. ${registro.identificador} -> ${registro.remitente_id} (Marco: ${registro.solicita_marco})`);
            });
        }

        console.log('🔍 === FIN DEBUG ===');
        return count[0].total;
    } catch (error) {
        console.error('Error en debug:', error);
        return 0;
    }
}

async function eliminarIdentificadorRemitente(identificador) {
    try {
        const sql = 'DELETE FROM identificador_remitente WHERE identificador = ?';
        const resultado = await db.query(sql, [identificador]);

        console.log(`Identificador eliminado: ${identificador} (${resultado.affectedRows} registros)`);
        return resultado.affectedRows > 0;
    } catch (error) {
        console.error(`Error al eliminar identificador ${identificador}:`, error);
        return false;
    }
}

async function incrementarIntentosTodos() {
    try {
        const sql = `
            UPDATE identificador_remitente 
            SET intentos = intentos + 1,
                fecha_ultimo_intento = NOW()
        `;

        const resultado = await db.query(sql);

        if (resultado.affectedRows > 0) {
            console.log(`Intentos incrementados para ${resultado.affectedRows} identificadores`);
        }

        return resultado.affectedRows;
    } catch (error) {
        console.error('Error al incrementar intentos:', error);
        return 0;
    }
}



async function limpiarCURPsExpiradas() {
    try {
        const TIMEOUT_20_MIN = 20;
        const MAX_INTENTOS = 80;

        const sql = `
            DELETE FROM identificador_remitente 
            WHERE 
                TIMESTAMPDIFF(MINUTE, fecha_creacion, NOW()) > ? 
                OR intentos > ?
        `;

        const resultado = await db.query(sql, [TIMEOUT_20_MIN, MAX_INTENTOS]);

        if (resultado.affectedRows > 0) {
            console.log(`Cleanup completado: ${resultado.affectedRows} CURPs eliminadas`);
        }

        return resultado.affectedRows;
    } catch (error) {
        console.error('Error en limpiarCURPsExpiradas:', error);
        return 0;
    }
}

async function obtenerIdentificadoresPendientes() {
    try {
        const sql = `
            SELECT 
                ir.*,
                TIMESTAMPDIFF(MINUTE, ir.fecha_creacion, NOW()) as minutos_transcurridos,
                g.nombre as nombre_grupo
            FROM identificador_remitente ir
            LEFT JOIN grupos g ON ir.remitente_id = g.id
            ORDER BY ir.fecha_creacion ASC
        `;

        const resultado = await db.query(sql);
        return resultado;
    } catch (error) {
        console.error('Error al obtener identificadores pendientes:', error);
        return [];
    }
}

async function contarIdentificadoresPendientes() {
    try {
        const sql = 'SELECT COUNT(*) as total FROM identificador_remitente';
        const resultado = await db.query(sql);
        return resultado[0].total;
    } catch (error) {
        console.error('Error al contar identificadores pendientes:', error);
        return 0;
    }
}

async function procesarEliminacionesPendientes() {
    try {
        const fs = require('fs');
        const path = require('path');
        const ROOT_DIR = path.resolve(__dirname, '..');
        const eliminacionesFile = path.join(ROOT_DIR, 'eliminaciones_pendientes.json');

        if (!fs.existsSync(eliminacionesFile)) {
            return 0;
        }

        const eliminaciones = JSON.parse(fs.readFileSync(eliminacionesFile, 'utf8'));

        if (eliminaciones.length === 0) {
            fs.unlinkSync(eliminacionesFile);
            return 0;
        }

        console.log(`Procesando ${eliminaciones.length} eliminaciones del admin panel...`);

        let procesadas = 0;
        for (const eliminacion of eliminaciones) {
            const eliminado = await eliminarIdentificadorRemitente(eliminacion.identificador);
            if (eliminado) procesadas++;
        }

        fs.unlinkSync(eliminacionesFile);

        console.log(`Eliminaciones procesadas: ${procesadas} CURPs eliminadas`);
        return procesadas;
    } catch (error) {
        console.error('Error procesando eliminaciones del admin panel:', error);
        return 0;
    }
}

// ===== FUNCIONES PARA CONTADORES Y ESTADÍSTICAS =====

async function incrementarContador(remitente) {
    try {
        let nombreRemitente;
        if (esGrupo(remitente)) {
            nombreRemitente = await getNombreGrupo(remitente);
        } else {
            nombreRemitente = formatearNumero(remitente);
        }

        const sql = `
            INSERT INTO contadores (remitente_id, nombre_remitente, total_documentos, fecha_primer_documento)
            VALUES (?, ?, 1, NOW())
            ON DUPLICATE KEY UPDATE
                total_documentos = total_documentos + 1,
                nombre_remitente = VALUES(nombre_remitente),
                fecha_ultimo_documento = NOW()
        `;

        await db.query(sql, [remitente, nombreRemitente]);
        console.log(`Contador incrementado para ${nombreRemitente}`);
        return true;
    } catch (error) {
        console.error(`Error al incrementar contador para ${remitente}:`, error);
        return false;
    }
}

async function restablecerContadores() {
    try {
        const sql = 'DELETE FROM contadores';
        const resultado = await db.query(sql);

        console.log(`Contadores restablecidos: ${resultado.affectedRows} registros eliminados`);
        return true;
    } catch (error) {
        console.error('Error al restablecer contadores:', error);
        return false;
    }
}

async function generarEstadisticas() {
    try {
        const sqlTotales = `
            SELECT 
                SUM(total_documentos) as total_global,
                COUNT(*) as total_usuarios
            FROM contadores
        `;

        const totales = await db.query(sqlTotales);
        const stats = totales[0];

        const sqlDetalle = `
            SELECT 
                c.remitente_id,
                c.nombre_remitente,
                c.total_documentos,
                g.nombre as nombre_grupo
            FROM contadores c
            LEFT JOIN grupos g ON c.remitente_id = g.id
            ORDER BY c.total_documentos DESC
        `;

        const detalle = await db.query(sqlDetalle);

        let mensaje = `📊 *Estadísticas de documentos enviados* 📊\n\n`;
        mensaje += `Total global: ${stats.total_global || 0} documentos\n\n`;
        mensaje += `*Detalle por usuario:*\n`;

        if (detalle.length === 0) {
            mensaje += "No hay estadísticas disponibles aún.";
        } else {
            detalle.forEach((usuario, index) => {
                let nombreMostrar = usuario.nombre_remitente;

                if (esGrupo(usuario.remitente_id) && usuario.nombre_grupo) {
                    nombreMostrar = `Grupo: ${usuario.nombre_grupo}`;
                }

                mensaje += `${index + 1}. ${nombreMostrar}: ${usuario.total_documentos} documentos\n`;
            });
        }

        const curpsPendientes = await contarIdentificadoresPendientes();
        if (curpsPendientes > 0) {
            mensaje += `\n\n*📋 CURPs en búsqueda activa: ${curpsPendientes}*\n`;

            const pendientes = await obtenerIdentificadoresPendientes();
            const primeros5 = pendientes.slice(0, 5);

            primeros5.forEach((item, index) => {
                mensaje += `${index + 1}. ${item.identificador}: ${item.intentos} intentos, ${item.minutos_transcurridos} min\n`;
            });

            if (pendientes.length > 5) {
                mensaje += `... y ${pendientes.length - 5} más\n`;
            }
        }

        return mensaje;
    } catch (error) {
        console.error('Error al generar estadísticas:', error);
        return "❌ Error al generar estadísticas desde MySQL.";
    }
}

// ===== FUNCIONES PARA GESTIÓN DE SOLICITUDES =====

async function registrarSolicitud(identificador, remitente, autorizado, datos) {
    try {
        let nombreRemitente;
        if (esGrupo(remitente)) {
            nombreRemitente = await getNombreGrupo(remitente);
        } else {
            nombreRemitente = formatearNumero(remitente);
        }

        const estado = autorizado ? 'pendiente' : 'rechazado';

        const sql = `
            INSERT INTO solicitudes (
                identificador, 
                remitente_id, 
                nombre_remitente,
                tipo_acta, 
                solicita_marco, 
                solicita_folio, 
                es_grupo_auto_marco,
                autorizado, 
                estado,
                intentos
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `;

        await db.query(sql, [
            identificador,
            remitente,
            nombreRemitente,
            datos.tipoActa,
            datos.solicitaMarco,
            datos.solicitaFolio,
            datos.esGrupoAutoMarco,
            autorizado,
            estado
        ]);

        console.log(`📝 Solicitud registrada en MySQL: ${identificador} de ${nombreRemitente} (autorizado: ${autorizado})`);
        return true;
    } catch (error) {
        console.error(`Error al registrar solicitud ${identificador}:`, error);
        return false;
    }
}

async function marcarComoProcesado(identificador, remitente) {
    try {
        const sql = `
            UPDATE solicitudes 
            SET estado = 'completado', 
                fecha_completado = NOW(),
                fecha_procesado = NOW()
            WHERE identificador = ? 
            AND remitente_id = ? 
            AND estado IN ('pendiente', 'procesando')
            ORDER BY fecha_solicitud DESC
            LIMIT 1
        `;

        const resultado = await db.query(sql, [identificador, remitente]);

        if (resultado.affectedRows > 0) {
            console.log(`✅ Marcado como procesado en MySQL: ${identificador} para ${await getNombreGrupo(remitente)}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`Error al marcar como procesado ${identificador}:`, error);
        return false;
    }
}

async function cargarTodasLasSolicitudes() {
    try {
        const sql = `SELECT COUNT(*) as total FROM solicitudes`;
        const resultado = await db.query(sql);
        const total = resultado[0].total;

        console.log(`📊 Todas las solicitudes cargadas desde MySQL: ${total} registros`);
        return total;
    } catch (error) {
        console.error('Error al cargar todas las solicitudes:', error);
        return 0;
    }
}

/**
 * Verificar si un usuario es administrador (desde MySQL)
 */
async function esAdmin(remitenteId) {
    try {
        const resultado = await db.query(`
            SELECT COUNT(*) as count 
            FROM administradores 
            WHERE remitente_id = ? AND activo = TRUE
        `, [remitenteId]);

        return resultado[0].count > 0;
    } catch (error) {
        console.error('Error verificando administrador:', error);
        return false;
    }
}

/**
 * Obtener todos los administradores activos
 */
async function obtenerAdministradores() {
    try {
        const admins = await db.query(`
            SELECT remitente_id, nombre, tipo_remitente, fecha_creacion
            FROM administradores 
            WHERE activo = TRUE
            ORDER BY fecha_creacion ASC
        `);

        return admins;
    } catch (error) {
        console.error('Error obteniendo administradores:', error);
        return [];
    }
}

/**
 * Agregar nuevo administrador
 */
async function agregarAdministrador(remitenteId, nombre, tipoRemitente = 'usuario', creadoPor = 'PANEL_WEB') {
    try {
        // Verificar si ya es administrador
        const yaEsAdmin = await esAdmin(remitenteId);
        if (yaEsAdmin) {
            return { success: false, message: 'Ya es administrador' };
        }

        await db.query(`
            INSERT INTO administradores (remitente_id, nombre, tipo_remitente, creado_por)
            VALUES (?, ?, ?, ?)
        `, [remitenteId, nombre, tipoRemitente, creadoPor]);

        // Si ya estaba en autorizaciones, eliminarlo (porque ahora es admin)
        await db.query(`
            DELETE FROM autorizaciones WHERE remitente_id = ?
        `, [remitenteId]);

        console.log(`Nuevo administrador agregado: ${nombre} (${remitenteId})`);
        return { success: true, message: 'Administrador agregado exitosamente' };
    } catch (error) {
        console.error('Error agregando administrador:', error);
        return { success: false, message: error.message };
    }
}

/**
 * Remover administrador (desactivar)
 */
async function removerAdministrador(remitenteId, removidoPor = 'PANEL_WEB') {
    try {
        const resultado = await db.query(`
            UPDATE administradores 
            SET activo = FALSE, fecha_actualizacion = CURRENT_TIMESTAMP
            WHERE remitente_id = ? AND activo = TRUE
        `, [remitenteId]);

        if (resultado.affectedRows === 0) {
            return { success: false, message: 'Administrador no encontrado' };
        }

        console.log(`Administrador removido: ${remitenteId} por ${removidoPor}`);
        return { success: true, message: 'Administrador removido exitosamente' };
    } catch (error) {
        console.error('Error removiendo administrador:', error);
        return { success: false, message: error.message };
    }
}

// Función para obtener configuración especial de un usuario
async function obtenerConfiguracionEspecial(remitenteId) {
    try {
        const sql = `
            SELECT 
                enmarcado_automatico,
                subir_api_automatico,
                configurado_por,
                fecha_configuracion
            FROM autorizaciones 
            WHERE remitente_id = ? AND autorizado = true
        `;
        
        const resultado = await db.query(sql, [remitenteId]);
        
        if (resultado.length > 0) {
            return {
                enmarcadoAutomatico: Boolean(resultado[0].enmarcado_automatico),
                subirApiAutomatico: Boolean(resultado[0].subir_api_automatico),
                configuradoPor: resultado[0].configurado_por,
                fechaConfiguracion: resultado[0].fecha_configuracion
            };
        }
        
        // Valores por defecto si no existe configuración
        return {
            enmarcadoAutomatico: false,
            subirApiAutomatico: false,
            configuradoPor: null,
            fechaConfiguracion: null
        };
        
    } catch (error) {
        console.error(`Error obteniendo configuración especial para ${remitenteId}:`, error);
        return {
            enmarcadoAutomatico: false,
            subirApiAutomatico: false,
            configuradoPor: null,
            fechaConfiguracion: null
        };
    }
}

// Función para actualizar configuración especial de un usuario
async function actualizarConfiguracionEspecial(remitenteId, enmarcadoAutomatico, subirApiAutomatico, configuradoPor = 'PANEL_WEB') {
    try {
        // Primero verificar que el usuario esté autorizado
        const sqlCheck = `
            SELECT COUNT(*) as count 
            FROM autorizaciones 
            WHERE remitente_id = ? AND autorizado = true
        `;
        
        const checkResult = await db.query(sqlCheck, [remitenteId]);
        
        if (checkResult[0].count === 0) {
            return {
                success: false,
                message: 'Usuario no está autorizado'
            };
        }
        
        // Actualizar configuración especial
        const sqlUpdate = `
            UPDATE autorizaciones 
            SET 
                enmarcado_automatico = ?, 
                subir_api_automatico = ?,
                configurado_por = ?,
                fecha_configuracion = NOW()
            WHERE remitente_id = ? AND autorizado = true
        `;
        
        const resultado = await db.query(sqlUpdate, [
            Boolean(enmarcadoAutomatico), 
            Boolean(subirApiAutomatico), 
            configuradoPor,
            remitenteId
        ]);
        
        if (resultado.affectedRows > 0) {
            console.log(`Configuración especial actualizada para ${remitenteId}: Enmarcado=${enmarcadoAutomatico}, API=${subirApiAutomatico}`);
            return {
                success: true,
                message: 'Configuración especial actualizada exitosamente'
            };
        } else {
            return {
                success: false,
                message: 'No se pudo actualizar la configuración'
            };
        }
        
    } catch (error) {
        console.error(`Error actualizando configuración especial para ${remitenteId}:`, error);
        return {
            success: false,
            message: error.message
        };
    }
}

async function debeUsarEnmarcadoAutomatico(remitenteId) {
    try {
        const config = await obtenerConfiguracionEspecial(remitenteId);
        return config.enmarcadoAutomatico;
    } catch (error) {
        console.error(`Error verificando enmarcado automático para ${remitenteId}:`, error);
        return false;
    }
}

// Función auxiliar para verificar si un usuario debe subir a API automáticamente
async function debeSubirApiAutomatico(remitenteId) {
    try {
        const config = await obtenerConfiguracionEspecial(remitenteId);
        return config.subirApiAutomatico;
    } catch (error) {
        console.error(`Error verificando subida API automática para ${remitenteId}:`, error);
        return false;
    }
}

// Exportar todas las funciones
module.exports = {
    db,
    cargarGrupos,
    guardarGrupo,
    getNombreGrupo,
    detectarYRegistrarGrupo,
    estaAutorizado,
    autorizarUsuario,
    desautorizarUsuario,
    autorizarGrupo,
    desautorizarGrupo,
    obtenerTodosLosAutorizados,
    recargarAutorizaciones,
    agregarIdentificadorRemitente,
    obtenerDatosRemitente,
    eliminarIdentificadorRemitente,
    incrementarIntentosTodos,
    limpiarCURPsExpiradas,
    obtenerIdentificadoresPendientes,
    contarIdentificadoresPendientes,
    procesarEliminacionesPendientes,
    incrementarContador,
    restablecerContadores,
    generarEstadisticas,
    registrarSolicitud,
    marcarComoProcesado,
    cargarTodasLasSolicitudes,
    esAdmin,
    obtenerAdministradores,
    agregarAdministrador,
    removerAdministrador,
    obtenerConfiguracionEspecial,
    actualizarConfiguracionEspecial,
    debeUsarEnmarcadoAutomatico,
    debeSubirApiAutomatico


};
