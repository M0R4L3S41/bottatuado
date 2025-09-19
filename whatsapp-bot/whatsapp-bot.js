// Integración con la API de Flask para procesar mensajes de WhatsApp
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const FormData = require('form-data');
const NodeCache = require('node-cache');

require('dotenv').config();
const {
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
    contarIdentificadoresPendientes,
    obtenerIdentificadoresPendientes,
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
    debeUsarEnmarcadoAutomatico,
    debeSubirApiAutomatico
} = require('./database');

// URL base de la API de Flask
const API_URL = 'http://localhost:5000/api';

// Cache para metadatos de grupos
const groupCache = new NodeCache({
    stdTTL: 300, // 5 minutos
    useClones: false,
    checkperiod: 60
});

const colaArchivos = [];
let procesandoCola = false;

// Configuración para el servidor de URLs
const URL_SERVER = {
    URL: process.env.URL_SERVER || 'https://api-production-f9fb.up.railway.app',
    API_KEY: process.env.URL_SERVER_API_KEY || 'clave-secreta-cambiar'
};

// Rutas del sistema
const ROOT_DIR = path.resolve(__dirname, '..');
const CARPETA_PARA_ENVIAR = path.join(ROOT_DIR, 'curpParaEnviar');
const CARPETA_DB_PDF = path.join(ROOT_DIR, 'db_pdf');
const DOWNLOADS_FOLDER = path.join(ROOT_DIR, 'downloads');
const PROCESSED_FOLDER = path.join(ROOT_DIR, 'processed');
const SESSION_FOLDER = path.join(ROOT_DIR, '.wwebjs_auth');

const INTERVALO_VERIFICACION = 15 * 1000;

// Crear carpetas necesarias
for (const folder of [DOWNLOADS_FOLDER, CARPETA_PARA_ENVIAR, CARPETA_DB_PDF, PROCESSED_FOLDER, SESSION_FOLDER]) {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
}

// Expresiones regulares para validación
const CURP_REGEX = /[A-Za-z]{4}\d{6}[A-Za-z]{6}[0-9A-Za-z]{2}/g;
const CADENA_20_NUMEROS_REGEX = /\b\d{20}\b/g;

function validarCURP(curp) {
    return /^[A-Za-z]{4}\d{6}[A-Za-z]{6}[0-9A-Za-z]{2}$/.test(curp);
}

function validarCadena20Numeros(cadena) {
    return /^\d{20}$/.test(cadena);
}

function formatearNumero(numero) {
    if (!numero) return "Desconocido";
    const numeroLimpio = numero.split('@')[0];
    return `+${numeroLimpio}`;
}

function esGrupo(remitente) {
    return remitente && remitente.endsWith('@g.us');
}

async function esGrupoEspecial(remitente) {
    console.log(`🔍 DEBUG: esGrupoEspecial llamada para ${remitente} - RETORNANDO FALSE`);
    return false;
}

async function debeEnmarcarAutomaticamente(remitente) {
    try {
        return await debeUsarEnmarcadoAutomatico(remitente);
    } catch (error) {
        console.error(`Error verificando enmarcado automático para ${remitente}:`, error);
        return false;
    }
}

function cargar_archivo_json(ruta_archivo, default_value = []) {
    if (fs.existsSync(ruta_archivo)) {
        try {
            const data = fs.readFileSync(ruta_archivo, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error(`Error al cargar ${ruta_archivo}:`, error);
            return default_value;
        }
    }
    return default_value;
}

function extraerIdentificadores(texto) {
    if (!texto) return { validos: [], invalidos: [] };

    const resultados = { validos: [], invalidos: [] };

    const posiblesCURPs = texto.match(CURP_REGEX) || [];
    for (const curp of posiblesCURPs) {
        const curpUpper = curp.toUpperCase();
        if (validarCURP(curpUpper)) {
            resultados.validos.push(curpUpper);
        } else {
            resultados.invalidos.push(curpUpper);
        }
    }

    const posiblesCadenas = texto.match(CADENA_20_NUMEROS_REGEX) || [];
    for (const cadena of posiblesCadenas) {
        if (validarCadena20Numeros(cadena)) {
            resultados.validos.push(cadena);
        } else {
            resultados.invalidos.push(cadena);
        }
    }

    resultados.validos = [...new Set(resultados.validos)];
    resultados.invalidos = [...new Set(resultados.invalidos)];

    return resultados;
}

function determinarTipoActa(mensaje) {
    const mensajeLower = mensaje.toLowerCase();

    if (mensajeLower.includes('mat') || mensajeLower.includes('matrimonio')) {
        return 'matrimonio';
    } else if (mensajeLower.includes('def') || mensajeLower.includes('defuncion')) {
        return 'defuncion';
    } else if (mensajeLower.includes('div') || mensajeLower.includes('divorcio')) {
        return 'divorcio';
    } else if (mensajeLower.includes('nac') || mensajeLower.includes('nacimiento')) {
        return 'nacimiento';
    }

    return 'nacimiento';
}

function construirMensajeParaAPI(destinatario) {
    let mensaje = "";

    if (Boolean(destinatario.solicitaMarco)) {  // Cambiar aquí también
        mensaje += "marco ";
    }

    if (Boolean(destinatario.solicitaFolio)) {  // Y aquí
        mensaje += "folio ";
    }

    if (destinatario.tipoActa) {
        mensaje += destinatario.tipoActa;
    }

    return mensaje.trim() || "procesamiento estándar";
}


function formatearOpcionesEnmarcado(opciones) {
    /**
     * Formatea las opciones aplicadas para mostrar al usuario
     */
    const aplicadas = [];

    if (opciones.apply_front) aplicadas.push("Marco frontal");
    if (opciones.apply_rear) aplicadas.push("Marco trasero");
    if (opciones.apply_folio) aplicadas.push("Folio");
    if (opciones.only_first_page) aplicadas.push("Solo primera página");

    return aplicadas.length > 0 ? aplicadas.join(", ") : "Procesamiento estándar";
}

async function subirDocumentoAServidor(rutaArchivo, identificador) {
    try {
        if (!fs.existsSync(rutaArchivo)) {
            return { success: false, message: "El archivo no existe" };
        }

        const formData = new FormData();
        formData.append('documento', fs.createReadStream(rutaArchivo));
        formData.append('identificador', identificador);

        const headers = {
            ...formData.getHeaders(),
            'X-API-Key': URL_SERVER.API_KEY
        };

        const response = await axios.post(`${URL_SERVER.URL}/api/subir`, formData, { headers });

        if (response.status === 200 && response.data.success) {
            return {
                success: true,
                message: "Documento subido exitosamente",
                data: response.data.data
            };
        } else {
            return {
                success: false,
                message: response.data.message || "Error al subir documento"
            };
        }
    } catch (error) {
        return { success: false, message: `Error: ${error.message}` };
    }
}

async function detectarArchivos() {
    try {
        if (!fs.existsSync(CARPETA_PARA_ENVIAR)) {
            return;
        }

        const archivos = fs.readdirSync(CARPETA_PARA_ENVIAR);

        // FILTRAR archivos que NO queremos procesar
        const pdfs = archivos.filter(archivo => {
            // Solo PDFs
            if (!archivo.toLowerCase().endsWith('.pdf')) {
                return false;
            }

            // EXCLUIR archivos temporales y procesados
            if (archivo.startsWith('backup_') ||
                archivo.startsWith('enmarcado_') ||
                archivo.includes('_temp_') ||
                archivo.includes('_processed_')) {
                return false;
            }

            return true;
        });

        if (pdfs.length === 0) {
            return;
        }

        let archivosNuevos = 0;

        for (const pdf of pdfs) {
            if (!colaArchivos.includes(pdf)) {
                const rutaCompleta = path.join(CARPETA_PARA_ENVIAR, pdf);
                try {
                    const stats = fs.statSync(rutaCompleta);
                    if (stats.isFile() && stats.size > 0) {
                        colaArchivos.push(pdf);
                        archivosNuevos++;
                        console.log(`📥 Archivo agregado a cola: ${pdf} (${stats.size} bytes)`);
                    }
                } catch (fileError) {
                    console.error(`⚠️ Error verificando archivo ${pdf}:`, fileError.message);
                }
            }
        }

        if (archivosNuevos > 0) {
            console.log(`📊 Cola actualizada: ${colaArchivos.length} archivos pendientes (${archivosNuevos} nuevos)`);

            if (!procesandoCola && colaArchivos.length > 0) {
                console.log(`🚀 Iniciando procesamiento de cola...`);
                procesarCola();
            }
        }

        // Incrementar intentos si no hay archivos nuevos
        if (archivosNuevos === 0) {
            const totalPendientes = await contarIdentificadoresPendientes();
            if (totalPendientes > 0) {
                await incrementarIntentosTodos();
            }
        }

    } catch (error) {
        console.error('❌ Error en detectarArchivos:', error);
    }
}

async function mostrarConfiguracionEspecial(remitente) {
    try {
        const config = await obtenerConfiguracionEspecial(remitente);
        const nombreRemitente = await getNombreGrupo(remitente);

        console.log(`⚙️ Configuración especial para ${nombreRemitente}:`);
        console.log(`   - Enmarcado automático: ${config.enmarcadoAutomatico ? 'SÍ' : 'NO'}`);
        console.log(`   - Subir API automático: ${config.subirApiAutomatico ? 'SÍ' : 'NO'}`);
        if (config.fechaConfiguracion) {
            console.log(`   - Configurado: ${config.fechaConfiguracion}`);
        }

        return config;
    } catch (error) {
        console.error(`Error mostrando configuración para ${remitente}:`, error);
        return null;
    }
}

async function procesarArchivoIndividual(client, nombreArchivo) {
    try {
        const rutaCompleta = path.join(CARPETA_PARA_ENVIAR, nombreArchivo);

        if (!fs.existsSync(rutaCompleta)) {
            console.log(`⚠️ Archivo ${nombreArchivo} ya no existe, saltando...`);
            return;
        }

        const posiblesIds = extraerIdentificadores(nombreArchivo);

        if (posiblesIds.validos.length === 0) {
            console.log(`❌ No se pudo extraer identificador válido del archivo: ${nombreArchivo}`);
            return;
        }

        const identificador = posiblesIds.validos[0];
        console.log(`🔍 Procesando archivo: ${nombreArchivo} con identificador: ${identificador}`);

        // Buscar destinatario en MySQL - CORREGIDO
        let destinatario = await obtenerDatosRemitente(identificador);

        console.log(`🔍 Resultado búsqueda para ${identificador}:`, destinatario ? 'ENCONTRADO' : 'NO ENCONTRADO');

        if (destinatario) {
            console.log(`📋 Datos del destinatario encontrado:`, {
                remitente: destinatario.remitente,
                tipoActa: destinatario.tipoActa,
                solicitaMarco: destinatario.solicitaMarco,
                solicitaFolio: destinatario.solicitaFolio
            });
        }

        // Si NO hay destinatario, buscar al primer administrador
        if (!destinatario) {
            console.log(`⚠️ No se encontró destinatario para ${identificador}, buscando administrador...`);

            const administradores = await obtenerAdministradores();
            const primerAdmin = administradores.length > 0 ? administradores[0].remitente_id : null;

            if (!primerAdmin) {
                console.error('❌ No hay administradores disponibles para enviar archivo sin destinatario');
                return;
            }

            console.log(`📧 Enviando a administrador: ${primerAdmin}`);

            // Crear datos por defecto para admin
            destinatario = {
                remitente: primerAdmin,
                solicitaMarco: false,
                tipoActa: 'nacimiento',
                solicitaFolio: false,
                esGrupoAutoMarco: false
            };

            // Notificar a todos los administradores sobre archivo sin destinatario
            await notificarAdmins(client,
                `⚠️ Archivo PDF encontrado para ${identificador} sin destinatario registrado.\n` +
                `📁 Archivo: ${nombreArchivo}\n` +
                `📤 Enviado al primer administrador disponible.`
            );
        } else {
            // Si SÍ hay destinatario, mostrar información
            const nombreDestinatario = await getNombreGrupo(destinatario.remitente);
            console.log(`✅ Destinatario encontrado para ${identificador}: ${nombreDestinatario}`);
        }

        const necesitaEnmarcado = Boolean(destinatario.solicitaMarco);
        console.log(`🖼️ ¿Necesita enmarcado? ${necesitaEnmarcado ? 'SÍ' : 'NO'}`);

        if (necesitaEnmarcado) {
            // Procesamiento con enmarcado usando la nueva API
            try {
                const fileStats = fs.statSync(rutaCompleta);
                if (!fileStats.isFile() || fileStats.size === 0) {
                    throw new Error(`El archivo ${nombreArchivo} no es válido o está vacío`);
                }

                console.log(`🖼️ Enmarcando archivo: ${nombreArchivo}`);

                // Backup del archivo original con timestamp para evitar conflictos
                const timestamp = Date.now();
                const backupPath = path.join(CARPETA_PARA_ENVIAR, `backup_${timestamp}_${nombreArchivo}`);
                fs.copyFileSync(rutaCompleta, backupPath);

                // Preparar datos para la API de enmarcado
                const requestData = {
                    mensaje: construirMensajeParaAPI(destinatario),
                    remitente: destinatario.remitente,
                    nombre: await getNombreGrupo(destinatario.remitente),
                    archivo_original: rutaCompleta,
                    tipo_acta: destinatario.tipoActa || 'nacimiento',
                    aplicar_folio: Boolean(destinatario.solicitaFolio),
                    esGrupoAutoMarco: Boolean(destinatario.esGrupoAutoMarco)
                };

                console.log(`📤 Enviando solicitud de enmarcado a API...`);

                // Llamar a la API de enmarcado
                const response = await axios.post(`${API_URL}/mensaje_whatsapp`, requestData, {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000 // 60 segundos timeout
                });

                if (response.data.success && response.data.pdf_path) {
                    if (!fs.existsSync(response.data.pdf_path)) {
                        throw new Error(`El archivo enmarcado no existe: ${response.data.pdf_path}`);
                    }

                    console.log(`📤 Enviando PDF enmarcado a ${await getNombreGrupo(destinatario.remitente)}`);

                    // Crear MessageMedia para el documento enmarcado
                    const media = MessageMedia.fromFilePath(response.data.pdf_path);
                    await client.sendMessage(destinatario.remitente, media, {
                        caption: `📄 ${identificador}\n`
                    });

                    await incrementarContador(destinatario.remitente);

                    // Procesar URL de descarga si es grupo especial
                    /*       if (esGrupoEspecial(destinatario.remitente)) {
                               try {
                                   const resultado = await subirDocumentoAServidor(response.data.pdf_path, identificador);
                                   if (resultado.success) {
                                       await client.sendMessage(destinatario.remitente,
                                           `🔗 *URL de descarga disponible:*\nCURP: ${identificador}\n${resultado.data.pageUrl}\n\n⏰ Este enlace expirará en 24 horas.`
                                       );
                                   }
                               } catch (error) {
                                   console.error(`Error al procesar URL de descarga:`, error);
                               }
                           }
                               */

                    // Cleanup exitoso - ORDEN IMPORTANTE
                    await eliminarIdentificadorRemitente(identificador);
                    await marcarComoProcesado(identificador, destinatario.remitente);

                    // 1. Eliminar archivo original PRIMERO
                    try {
                        fs.unlinkSync(rutaCompleta);
                        console.log(`🗑️ Archivo original eliminado: ${rutaCompleta}`);
                    } catch (error) {
                        console.error(`Error eliminando archivo original:`, error.message);
                    }

                    // 2. Eliminar backup
                    try {
                        fs.unlinkSync(backupPath);
                        console.log(`🗑️ Backup eliminado: ${backupPath}`);
                    } catch (error) {
                        console.error(`Error eliminando backup:`, error.message);
                    }

                    // 3. Programar eliminación del archivo enmarcado con verificación
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(response.data.pdf_path)) {
                                fs.unlinkSync(response.data.pdf_path);
                                console.log(`🗑️ Archivo temporal enmarcado eliminado: ${response.data.pdf_path}`);
                            }
                        } catch (cleanupError) {
                            console.error(`Error limpiando archivo temporal:`, cleanupError.message);
                        }
                    }, 3000); // Reducir a 3 segundos

                    console.log(`✅ Archivo ${nombreArchivo} procesado y enviado exitosamente`);

                } else {
                    throw new Error(response.data.message || 'Error desconocido en enmarcado');
                }

            } catch (error) {
                console.error(`❌ Error al enmarcar ${identificador}:`, error.message);

                // Enviar sin enmarcar como respaldo
                console.log(`📤 Enviando archivo original sin enmarcar como respaldo`);
                const media = MessageMedia.fromFilePath(rutaCompleta);
                await client.sendMessage(destinatario.remitente, media, {
                    caption: `📄 Documento para: ${identificador}\n⚠️ (No se pudo enmarcar: ${error.message.substring(0, 100)})`
                });

                await incrementarContador(destinatario.remitente);

                // Procesar URL si es grupo especial
                /*  if (esGrupoEspecial(destinatario.remitente)) {
                     try {
                         const resultado = await subirDocumentoAServidor(rutaCompleta, identificador);
                         if (resultado.success) {
                             await client.sendMessage(destinatario.remitente,
                                 `🔗 *URL de descarga disponible:*\n${resultado.data.pageUrl}\n\n⏰ Este enlace expirará en 24 horas.`
                             );
                         }
                     } catch (urlError) {
                         console.error(`Error al procesar URL de descarga:`, urlError);
                     }
                 }*/

                await eliminarIdentificadorRemitente(identificador);
                await marcarComoProcesado(identificador, destinatario.remitente);

                // Limpiar archivo original
                try {
                    fs.unlinkSync(rutaCompleta);
                } catch (cleanupError) {
                    console.error(`Error limpiando archivo original:`, cleanupError.message);
                }
            }

        } else {
            // Procesamiento sin enmarcado
            console.log(`📤 Enviando PDF sin enmarcar a ${await getNombreGrupo(destinatario.remitente)}`);

            const media = MessageMedia.fromFilePath(rutaCompleta);
            await client.sendMessage(destinatario.remitente, media, {
                caption: `📄 Documento para: ${identificador}`
            });

            await incrementarContador(destinatario.remitente);

            /*  if (esGrupoEspecial(destinatario.remitente)) {
                 try {
                     const resultado = await subirDocumentoAServidor(rutaCompleta, identificador);
                     if (resultado.success) {
                         await client.sendMessage(destinatario.remitente,
                             `🔗 *URL de descarga disponible:*\n${resultado.data.pageUrl}\n\n⏰ Este enlace expirará en 24 horas.`
                         );
                     }
                 } catch (error) {
                     console.error(`Error al procesar URL de descarga:`, error);
                 }
             }  */

            await eliminarIdentificadorRemitente(identificador);
            await marcarComoProcesado(identificador, destinatario.remitente);

            // Limpiar archivo original
            try {
                fs.unlinkSync(rutaCompleta);
                console.log(`✅ Archivo ${nombreArchivo} procesado y enviado exitosamente`);
            } catch (cleanupError) {
                console.error(`Error limpiando archivo:`, cleanupError.message);
            }
        }

    } catch (error) {
        console.error(`❌ Error crítico procesando archivo ${nombreArchivo}:`, error);
    }
}
// Funciones auxiliares nuevas que necesitas agregar:

async function procesarCola() {
    if (procesandoCola) {
        console.log('⏳ Ya hay un procesamiento de cola activo, saltando...');
        return;
    }

    procesandoCola = true;
    console.log(`🔄 Iniciando procesamiento de cola con ${colaArchivos.length} archivos`);

    try {
        while (colaArchivos.length > 0) {
            const nombreArchivo = colaArchivos.shift();
            console.log(`🔄 Procesando archivo: ${nombreArchivo} (quedan ${colaArchivos.length} en cola)`);

            try {
                const rutaCompleta = path.join(CARPETA_PARA_ENVIAR, nombreArchivo);
                if (!fs.existsSync(rutaCompleta)) {
                    console.log(`⚠️ Archivo ${nombreArchivo} ya no existe, continuando con el siguiente`);
                    continue;
                }

                await procesarArchivoIndividual(global.client, nombreArchivo);
                console.log(`✅ Archivo ${nombreArchivo} procesado exitosamente`);

            } catch (error) {
                console.error(`❌ Error procesando archivo ${nombreArchivo}:`, error.message);
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`🎉 Procesamiento de cola completado. Cola vacía.`);

    } catch (error) {
        console.error('❌ Error crítico en procesarCola:', error);
    } finally {
        procesandoCola = false;
    }
}

async function limpiarArchivosTemporales() {
    try {
        if (!fs.existsSync(CARPETA_PARA_ENVIAR)) {
            return;
        }

        const archivos = fs.readdirSync(CARPETA_PARA_ENVIAR);
        let archivosEliminados = 0;

        for (const archivo of archivos) {
            // Eliminar archivos temporales antiguos
            if (archivo.startsWith('backup_') ||
                archivo.startsWith('enmarcado_') ||
                archivo.includes('_temp_')) {

                try {
                    const rutaCompleta = path.join(CARPETA_PARA_ENVIAR, archivo);
                    const stats = fs.statSync(rutaCompleta);

                    // Eliminar archivos temporales más antiguos de 10 minutos
                    const tiempoTranscurrido = Date.now() - stats.mtime.getTime();
                    if (tiempoTranscurrido > 10 * 60 * 1000) { // 10 minutos
                        fs.unlinkSync(rutaCompleta);
                        archivosEliminados++;
                        console.log(`🗑️ Archivo temporal antiguo eliminado: ${archivo}`);
                    }
                } catch (error) {
                    console.error(`Error eliminando archivo temporal ${archivo}:`, error.message);
                }
            }
        }

        if (archivosEliminados > 0) {
            console.log(`🧹 Limpieza completada: ${archivosEliminados} archivos temporales eliminados`);
        }

    } catch (error) {
        console.error('Error en limpieza de archivos temporales:', error);
    }
}

async function notificarAdmins(client, mensaje) {
    try {
        const administradores = await obtenerAdministradores();

        for (const admin of administradores) {
            try {
                await client.sendMessage(admin.remitente_id, mensaje);
                console.log(`Notificación enviada a admin: ${admin.nombre}`);
            } catch (error) {
                console.error(`Error enviando mensaje a admin ${admin.remitente_id}:`, error);
            }
        }
    } catch (error) {
        console.error('Error notificando administradores:', error);
    }
}
async function procesarNotificacionesPendientes(client) {
    try {
        const archivosTemp = fs.readdirSync(ROOT_DIR).filter(archivo =>
            archivo.startsWith('notif_temp_') && archivo.endsWith('.json')
        );

        if (archivosTemp.length === 0) {
            return;
        }

        console.log(`📱 Procesando ${archivosTemp.length} notificaciones pendientes...`);

        for (const archivoTemp of archivosTemp) {
            try {
                const rutaCompleta = path.join(ROOT_DIR, archivoTemp);
                const contenido = fs.readFileSync(rutaCompleta, 'utf8');
                const notificacion = JSON.parse(contenido);

                if (notificacion.procesado) {
                    fs.unlinkSync(rutaCompleta);
                    continue;
                }

                const { destinatario, mensaje, identificador } = notificacion;

                await client.sendMessage(destinatario, mensaje);
                console.log(`✅ Notificación enviada a ${formatearNumero(destinatario)}`);

                fs.unlinkSync(rutaCompleta);

            } catch (error) {
                console.error(`❌ Error procesando notificación ${archivoTemp}:`, error);
            }
        }
    } catch (error) {
        console.error('❌ Error en procesarNotificacionesPendientes:', error);
    }
}

async function procesarColaMensajes(client) {
    try {
        const mensajesPendientesFile = path.join(ROOT_DIR, 'mensajes_pendientes.json');

        if (!fs.existsSync(mensajesPendientesFile)) {
            return;
        }

        const mensajesPendientes = cargar_archivo_json(mensajesPendientesFile, []);

        if (mensajesPendientes.length === 0) {
            return;
        }

        console.log(`📬 Procesando ${mensajesPendientes.length} mensajes en cola...`);

        const mensajesProcesados = [];

        for (const mensaje of mensajesPendientes) {
            try {
                const { destinatario, mensaje: texto, identificador } = mensaje;

                await client.sendMessage(destinatario, texto);
                console.log(`✅ Mensaje en cola enviado a ${formatearNumero(destinatario)}`);

                mensajesProcesados.push(mensaje);
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                console.error(`❌ Error enviando mensaje en cola:`, error);
            }
        }

        if (mensajesProcesados.length > 0) {
            const mensajesRestantes = mensajesPendientes.filter(msg =>
                !mensajesProcesados.some(proc =>
                    proc.destinatario === msg.destinatario &&
                    proc.identificador === msg.identificador
                )
            );

            fs.writeFileSync(mensajesPendientesFile, JSON.stringify(mensajesRestantes, null, 2));
            console.log(`✅ Cola actualizada: ${mensajesProcesados.length} mensajes enviados, ${mensajesRestantes.length} restantes`);
        }

    } catch (error) {
        console.error('❌ Error en procesarColaMensajes:', error);
    }
}


async function conectarWhatsApp() {
    console.log('🔄 Inicializando base de datos...');
    const dbInitialized = await db.init();
    console.log('🔍 VERIFICANDO IMPORTACIONES:');
    console.log('- obtenerTodosLosAutorizados:', typeof obtenerTodosLosAutorizados);
    console.log('- obtenerIdentificadoresPendientes:', typeof obtenerIdentificadoresPendientes);
    console.log('- contarIdentificadoresPendientes:', typeof contarIdentificadoresPendientes);
    if (!dbInitialized) {
        console.error('❌ No se pudo conectar a la base de datos. Deteniendo bot.');
        process.exit(1);
    }

    // Crear cliente de WhatsApp Web
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: SESSION_FOLDER
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-images',
            '--disable-web-security',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--memory-pressure-off',
            '--max-old-space-size=512',
            '--disable-features=VizDisplayCompositor',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows'
        ],
        timeout: 90000
        // NO especificar executablePath - dejar que lo encuentre automáticamente
    }
});
    await cargarGrupos();
    await recargarAutorizaciones();
    await cargarTodasLasSolicitudes();

    client.on('qr', (qr) => {
        qrcode.generate(qr, { small: true });
        console.log('Escanea el código QR con tu teléfono');
    });

    client.on('ready', async () => {
        console.log('Conexión establecida');
        try {
            const administradores = await obtenerAdministradores();
            if (administradores.length === 0) {
                console.error('⚠️ ¡ADVERTENCIA! No hay administradores registrados en el sistema.');
                console.log('💡 Crea administradores manualmente en la tabla `administradores` de MySQL');
            } else {
                console.log(`✅ Sistema iniciado con ${administradores.length} administradores:`);
                administradores.forEach(admin => {
                    console.log(`   - ${admin.nombre} (${admin.remitente_id})`);
                });
            }
        } catch (error) {
            console.error('Error verificando administradores:', error);
        }

        console.log('📱 Iniciando procesamiento de notificaciones del panel admin...');
        setInterval(async () => {
            if (global.client) {
                await procesarNotificacionesPendientes(global.client);
                await procesarColaMensajes(global.client);
            }
        }, 5000);

        setTimeout(async () => {
            if (global.client) {
                await procesarNotificacionesPendientes(global.client);
                await procesarColaMensajes(global.client);
            }
        }, 2000);

        global.client = client;

        console.log("Actualizando información de grupos conocidos...");
        try {
            await cargarGrupos();

            const chats = await client.getChats();
            for (const chat of chats) {
                if (chat.isGroup) {
                    await guardarGrupo(
                        chat.id._serialized,
                        chat.name || `Grupo: ${formatearNumero(chat.id._serialized)}`,
                        chat.participants?.length || 0
                    );
                }
            }

            const gruposActualizados = await cargarGrupos();
            console.log(`Información de grupos actualizada. ${gruposActualizados.length} grupos registrados en MySQL.`);
        } catch (error) {
            console.error("Error al actualizar información de grupos:", error);
        }

        console.log('🔄 Iniciando sistema de detección de archivos cada 15 segundos');
        setInterval(() => {
            try {
                procesarEliminacionesPendientes();
                detectarArchivos();
            } catch (error) {
                console.error('❌ Error en ciclo de monitoreo:', error);
            }
        }, INTERVALO_VERIFICACION);

        console.log('🔍 Ejecutando detección inicial de archivos...');
        detectarArchivos();
    });

    client.on('disconnected', (reason) => {
        console.log('🔌 Cliente desconectado:', reason);
        global.client = null;
        procesandoCola = false;
        console.log('🔌 Socket desconectado, sistema de cola pausado');
    });

    client.on('message', async (message) => {
        try {
            // Ignorar mensajes propios
            if (message.fromMe) return;

            const remitente = message.from;
            const texto = message.body || '';

            if (!texto) return;

            const esAdministrador = await esAdmin(remitente);
            if (esAdministrador) {
                // Extraer identificadores para verificar si hay CURPs en el mensaje
                const resultadosAdmin = extraerIdentificadores(texto);
                const tieneCurps = resultadosAdmin.validos && resultadosAdmin.validos.length > 0;

                if (tieneCurps) {
                    console.log(`🔇 IGNORANDO mensaje de administrador ${await getNombreGrupo(remitente)} con CURPs: ${resultadosAdmin.validos.join(', ')}`);
                    return; // Salir sin procesar ni responder nada
                }
                const comandoLower = texto.toLowerCase().trim();

                // COMANDO: restablecer contador
                if (comandoLower === "restablecer contador") {
                    try {
                        await restablecerContadores();
                        await client.sendMessage(remitente, "✅ Contadores restablecidos a cero.");

                        await notificarAdmins(client, "ℹ️ Los contadores han sido restablecidos por otro administrador.");
                    } catch (error) {
                        await client.sendMessage(remitente, "❌ Error al restablecer contadores: " + error.message);
                    }
                    return;
                }

                // COMANDO: grupos
                if (comandoLower === "grupos") {
                    try {
                        const grupos = await cargarGrupos();
                        let mensaje = "*Lista de grupos registrados*\n\n";

                        grupos.forEach((grupo, index) => {
                            mensaje += `${index + 1}. *${grupo.nombre}*\n`;
                            mensaje += `   - ID: ${formatearNumero(grupo.id)}\n`;
                            if (grupo.participantes) {
                                mensaje += `   - Participantes: ${grupo.participantes}\n`;
                            }
                            mensaje += `\n`;
                        });

                        await client.sendMessage(remitente, mensaje);
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al obtener grupos: " + error.message);
                    }
                    return;
                }

                // COMANDO: estadisticas
                if (comandoLower === "estadisticas") {
                    try {
                        const informe = await generarEstadisticas();
                        await client.sendMessage(remitente, informe);
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al generar estadísticas: " + error.message);
                    }
                    return;
                }
                // COMANDO: administradores
                if (comandoLower === "administradores") {
                    try {
                        const administradores = await obtenerAdministradores();
                        let mensaje = "*Lista de administradores del sistema*\n\n";

                        administradores.forEach((admin, index) => {
                            mensaje += `${index + 1}. *${admin.nombre}*\n`;
                            mensaje += `   - ID: ${formatearNumero(admin.remitente_id)}\n`;
                            mensaje += `   - Tipo: ${admin.tipo_remitente}\n`;
                            mensaje += `   - Desde: ${admin.fecha_creacion}\n\n`;
                        });

                        if (administradores.length === 0) {
                            mensaje = "⚠️ No hay administradores registrados en el sistema.";
                        }

                        await client.sendMessage(remitente, mensaje);
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al obtener administradores: " + error.message);
                    }
                    return;
                }

                // COMANDO: promover admin
                if (comandoLower.startsWith("config ")) {
                    const numeroConsultar = comandoLower.replace("config ", "").trim();
                    let usuarioFormateado = numeroConsultar;
                    if (!numeroConsultar.includes('@')) {
                        usuarioFormateado = `${numeroConsultar}@c.us`;
                    }

                    try {
                        const config = await mostrarConfiguracionEspecial(usuarioFormateado);
                        if (config) {
                            const nombreUsuario = await getNombreGrupo(usuarioFormateado);
                            let respuesta = `⚙️ *Configuración especial de ${nombreUsuario}*\n\n`;
                            respuesta += `🖼️ Enmarcado automático: ${config.enmarcadoAutomatico ? '✅ SÍ' : '❌ NO'}\n`;
                            respuesta += `🔗 Subir API automático: ${config.subirApiAutomatico ? '✅ SÍ' : '❌ NO'}\n`;

                            if (config.configuradoPor) {
                                respuesta += `👤 Configurado por: ${config.configuradoPor}\n`;
                            }
                            if (config.fechaConfiguracion) {
                                respuesta += `📅 Fecha: ${new Date(config.fechaConfiguracion).toLocaleString()}\n`;
                            }

                            await client.sendMessage(remitente, respuesta);
                        } else {
                            await client.sendMessage(remitente, `❌ No se encontró configuración para ${numeroConsultar}`);
                        }
                    } catch (error) {
                        await client.sendMessage(remitente, "Error consultando configuración: " + error.message);
                    }
                    return;
                }
                if (comandoLower.startsWith("promover admin ")) {
                    const numeroPromover = comandoLower.replace("promover admin ", "").trim();
                    let usuarioFormateado = numeroPromover;
                    if (!numeroPromover.includes('@')) {
                        usuarioFormateado = `${numeroPromover}@c.us`;
                    }

                    try {
                        const resultado = await agregarAdministrador(
                            usuarioFormateado,
                            `Admin ${formatearNumero(usuarioFormateado)}`,
                            usuarioFormateado.endsWith('@g.us') ? 'grupo' : 'usuario',
                            remitente
                        );

                        if (resultado.success) {
                            await client.sendMessage(remitente, `✅ ${numeroPromover} promovido a administrador exitosamente.`);

                            // Notificar a otros administradores
                            await notificarAdmins(client, `🔐 Nuevo administrador agregado: ${formatearNumero(usuarioFormateado)} por ${await getNombreGrupo(remitente)}`);
                        } else {
                            await client.sendMessage(remitente, `ℹ️ ${resultado.message}`);
                        }
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al promover administrador: " + error.message);
                    }
                    return;
                }

                // COMANDO: remover admin
                if (comandoLower.startsWith("remover admin ")) {
                    const numeroRemover = comandoLower.replace("remover admin ", "").trim();
                    let usuarioFormateado = numeroRemover;
                    if (!numeroRemover.includes('@')) {
                        usuarioFormateado = `${numeroRemover}@c.us`;
                    }

                    // Evitar auto-remoción accidental
                    if (usuarioFormateado === remitente) {
                        await client.sendMessage(remitente, "❌ No puedes removerte a ti mismo como administrador.");
                        return;
                    }

                    try {
                        const resultado = await removerAdministrador(usuarioFormateado, remitente);

                        if (resultado.success) {
                            await client.sendMessage(remitente, `✅ ${numeroRemover} removido como administrador.`);

                            // Notificar a otros administradores
                            await notificarAdmins(client, `⚠️ Administrador removido: ${formatearNumero(usuarioFormateado)} por ${await getNombreGrupo(remitente)}`);
                        } else {
                            await client.sendMessage(remitente, `❌ ${resultado.message}`);
                        }
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al remover administrador: " + error.message);
                    }
                    return;
                }

                // COMANDO: autorizar
                if (comandoLower.startsWith("autorizar ")) {
                    const numeroAutorizar = comandoLower.replace("autorizar ", "").trim();
                    let usuarioFormateado = numeroAutorizar;
                    if (!numeroAutorizar.includes('@')) {
                        usuarioFormateado = `${numeroAutorizar}@c.us`;
                    }

                    try {
                        const resultado = await autorizarUsuario(usuarioFormateado);
                        if (resultado) {
                            await client.sendMessage(remitente, `✅ Usuario ${numeroAutorizar} autorizado exitosamente.`);
                        } else {
                            await client.sendMessage(remitente, `ℹ️ El usuario ${numeroAutorizar} ya estaba autorizado.`);
                        }
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al autorizar usuario: " + error.message);
                    }
                    return;
                }

                // COMANDO: desautorizar
                if (comandoLower.startsWith("desautorizar ")) {
                    const numeroDesautorizar = comandoLower.replace("desautorizar ", "").trim();
                    let usuarioFormateado = numeroDesautorizar;
                    if (!numeroDesautorizar.includes('@')) {
                        usuarioFormateado = `${numeroDesautorizar}@c.us`;
                    }

                    try {
                        const resultado = await desautorizarUsuario(usuarioFormateado);
                        if (resultado) {
                            await client.sendMessage(remitente, `✅ Usuario ${numeroDesautorizar} desautorizado exitosamente.`);
                        } else {
                            await client.sendMessage(remitente, `ℹ️ El usuario ${numeroDesautorizar} no estaba en la lista de autorizados.`);
                        }
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al desautorizar usuario: " + error.message);
                    }
                    return;
                }

                // COMANDO: autorizar grupo
                if (comandoLower.startsWith("autorizar grupo ")) {
                    const grupoId = comandoLower.replace("autorizar grupo ", "").trim();
                    let grupoFormateado = grupoId;
                    if (!grupoId.includes('@g.us')) {
                        grupoFormateado = `${grupoId}@g.us`;
                    }

                    try {
                        const resultado = await autorizarGrupo(grupoFormateado);
                        if (resultado) {
                            await client.sendMessage(remitente, `✅ Grupo ${grupoId} autorizado exitosamente.`);
                        } else {
                            await client.sendMessage(remitente, `ℹ️ El grupo ${grupoId} ya estaba autorizado.`);
                        }
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al autorizar grupo: " + error.message);
                    }
                    return;
                }

                // COMANDO: desautorizar grupo
                if (comandoLower.startsWith("desautorizar grupo ")) {
                    const grupoId = comandoLower.replace("desautorizar grupo ", "").trim();
                    let grupoFormateado = grupoId;
                    if (!grupoId.includes('@g.us')) {
                        grupoFormateado = `${grupoId}@g.us`;
                    }

                    try {
                        const resultado = await desautorizarGrupo(grupoFormateado);
                        if (resultado) {
                            await client.sendMessage(remitente, `✅ Grupo ${grupoId} desautorizado exitosamente.`);
                        } else {
                            await client.sendMessage(remitente, `ℹ️ El grupo ${grupoId} no estaba en la lista de autorizados.`);
                        }
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al desautorizar grupo: " + error.message);
                    }
                    return;
                }

                // COMANDO: autorizados
                if (comandoLower === "autorizados") {
                    try {
                        const autorizados = await obtenerTodosLosAutorizados();
                        let mensaje = "*Lista de usuarios y grupos autorizados:*\n\n";

                        const administradores = await obtenerAdministradores();
                        mensaje += "*Administradores (siempre autorizados):*\n";
                        administradores.forEach((admin, index) => {
                            mensaje += `${index + 1}. ${admin.nombre} (${formatearNumero(admin.remitente_id)})\n`;
                        });

                        const usuarios = autorizados.filter(a => a.tipo_remitente === 'usuario');
                        const grupos = autorizados.filter(a => a.tipo_remitente === 'grupo');

                        if (usuarios.length > 0) {
                            mensaje += "\n*Usuarios autorizados:*\n";
                            usuarios.forEach((usuario, index) => {
                                mensaje += `${index + 1}. ${formatearNumero(usuario.remitente_id)}\n`;
                            });
                        }

                        if (grupos.length > 0) {
                            mensaje += "\n*Grupos autorizados:*\n";
                            for (let i = 0; i < grupos.length; i++) {
                                const grupo = grupos[i];
                                const nombreGrupo = grupo.nombre_grupo || await getNombreGrupo(grupo.remitente_id);
                                mensaje += `${i + 1}. ${nombreGrupo}\n`;
                            }
                        }

                        if (usuarios.length === 0 && grupos.length === 0) {
                            mensaje += "\n*No hay usuarios ni grupos autorizados dinámicamente.*";
                        }

                        await client.sendMessage(remitente, mensaje);
                    } catch (error) {
                        await client.sendMessage(remitente, "Error al obtener lista de autorizados: " + error.message);
                    }
                    return;
                }

                // COMANDO: iniciar (envío masivo)
                if (comandoLower === "iniciar") {
                    await client.sendMessage(remitente, "🚀 Iniciando envío masivo de publicidad...\n\nBuscando destinatarios...");

                    try {
                        const autorizados = await obtenerTodosLosAutorizados();
                        const pendientes = await obtenerIdentificadoresPendientes();

                        // Obtener usuarios únicos que han enviado solicitudes
                        const usuariosConSolicitudes = new Set();
                        for (const item of pendientes) {
                            usuariosConSolicitudes.add(item.remitente_id);
                        }

                        // Filtrar usuarios no autorizados
                        // Filtrar usuarios no autorizados
                        const autorizadosIds = autorizados.map(a => a.remitente_id);
                        const administradores = await obtenerAdministradores();
                        const adminIds = administradores.map(admin => admin.remitente_id);

                        const usuariosNoAutorizados = [...usuariosConSolicitudes].filter(
                            usuario => !autorizadosIds.includes(usuario) && !adminIds.includes(usuario)
                        );
                        const totalDestinatarios = autorizados.length + usuariosNoAutorizados.length;

                        console.log(`📢 Enviando publicidad a ${totalDestinatarios} destinatarios`);

                        // Ruta de la imagen publicitaria
                        const imagenPublicidad = path.join(ROOT_DIR, 'inicio.jpg');

                        if (!fs.existsSync(imagenPublicidad)) {
                            await client.sendMessage(remitente, "❌ Error: No se encontró la imagen de publicidad en: " + imagenPublicidad);
                            return;
                        }

                        let enviados = 0;
                        let errores = 0;

                        const enviarConDelay = async (destinatario, tipo) => {
                            try {
                                const media = MessageMedia.fromFilePath(imagenPublicidad);
                                await client.sendMessage(destinatario, media, {
                                    caption: "🚀 ¡Bienvenido a nuestro servicio de documentos!\n\n" +
                                        "✨ Procesamos tus documentos de forma rápida y segura\n" +
                                        "📄 Actas de nacimiento, matrimonio, defunción\n" +
                                        "🎯 Servicio automatizado\n\n" +
                                        "¡Envía tu CURP para comenzar!"
                                });

                                enviados++;
                                console.log(`✅ Enviado a ${tipo}: ${formatearNumero(destinatario)} (${enviados}/${totalDestinatarios})`);

                                await new Promise(resolve => setTimeout(resolve, 10000)); // 10 segundos
                            } catch (error) {
                                errores++;
                                console.log(`❌ Error enviando a ${tipo} ${formatearNumero(destinatario)}: ${error.message}`);
                            }
                        };

                        // Enviar a autorizados
                        for (const autorizado of autorizados) {
                            const tipo = autorizado.tipo_remitente === 'grupo' ? 'Grupo autorizado' : 'Usuario autorizado';
                            await enviarConDelay(autorizado.remitente_id, tipo);
                        }

                        // Enviar a no autorizados
                        for (const usuario of usuariosNoAutorizados) {
                            await enviarConDelay(usuario, 'Usuario no autorizado');
                        }

                        // Reporte final
                        await client.sendMessage(remitente,
                            `📊 *Reporte de envío masivo completado*\n\n` +
                            `✅ Enviados exitosamente: ${enviados}\n` +
                            `❌ Errores: ${errores}\n` +
                            `📱 Total destinatarios: ${totalDestinatarios}\n\n` +
                            `⏰ Tiempo estimado: ${Math.ceil(totalDestinatarios * 10 / 60)} minutos`
                        );

                    } catch (error) {
                        console.error('Error en comando iniciar:', error);
                        await client.sendMessage(remitente, `❌ Error ejecutando comando iniciar: ${error.message}`);
                    }
                    return;
                }

                // COMANDO: cerrado (envío masivo)
                // COMANDO: cerrado (envío masivo) - VERSIÓN MEJORADA
                if (comandoLower === "cerrado") {
                    await client.sendMessage(remitente, "🔒 Iniciando envío masivo - SERVICIO CERRADO...\n\nBuscando destinatarios...");

                    try {
                        // ✅ AGREGAR MANEJO DE ERRORES PARA CADA FUNCIÓN
                        let autorizados = [];
                        let pendientes = [];

                        try {
                            autorizados = await obtenerTodosLosAutorizados();
                            if (!Array.isArray(autorizados)) {
                                console.log('⚠️ obtenerTodosLosAutorizados no devolvió array, usando array vacío');
                                autorizados = [];
                            }
                        } catch (error) {
                            console.error('❌ Error obteniendo autorizados:', error);
                            autorizados = [];
                        }

                        try {
                            pendientes = await obtenerIdentificadoresPendientes();
                            if (!Array.isArray(pendientes)) {
                                console.log('⚠️ obtenerIdentificadoresPendientes no devolvió array, usando array vacío');
                                pendientes = [];
                            }
                        } catch (error) {
                            console.error('❌ Error obteniendo identificadores pendientes:', error);
                            pendientes = [];
                        }

                        // Obtener usuarios únicos que han enviado solicitudes
                        const usuariosConSolicitudes = new Set();

                        // ✅ VERIFICAR QUE pendientes SEA ARRAY ANTES DE ITERAR
                        if (Array.isArray(pendientes) && pendientes.length > 0) {
                            for (const item of pendientes) {
                                if (item && item.remitente_id) {
                                    usuariosConSolicitudes.add(item.remitente_id);
                                }
                            }
                        }

                        // Filtrar usuarios no autorizados
                        let administradores = [];
                        try {
                            administradores = await obtenerAdministradores();
                            if (!Array.isArray(administradores)) {
                                administradores = [];
                            }
                        } catch (error) {
                            console.error('❌ Error obteniendo administradores:', error);
                            administradores = [];
                        }

                        const adminIds = administradores.map(admin => admin.remitente_id);
                        const autorizadosIds = autorizados.map(a => a.remitente_id);

                        const usuariosNoAutorizados = [...usuariosConSolicitudes].filter(
                            usuario => !autorizadosIds.includes(usuario) && !adminIds.includes(usuario)
                        );

                        const totalDestinatarios = autorizados.length + usuariosNoAutorizados.length;

                        if (totalDestinatarios === 0) {
                            await client.sendMessage(remitente, "ℹ️ No se encontraron destinatarios para enviar el mensaje.");
                            return;
                        }

                        console.log(`🔒 Enviando mensaje de CERRADO a ${totalDestinatarios} destinatarios`);

                        // Ruta de la imagen de cerrado
                        const imagenCerrado = path.join(ROOT_DIR, 'cerrado.jpg');

                        if (!fs.existsSync(imagenCerrado)) {
                            await client.sendMessage(remitente, "❌ Error: No se encontró la imagen de cerrado en: " + imagenCerrado);
                            return;
                        }

                        let enviados = 0;
                        let errores = 0;

                        const enviarConDelay = async (destinatario, tipo) => {
                            try {
                                const media = MessageMedia.fromFilePath(imagenCerrado);
                                await client.sendMessage(destinatario, media, {
                                    caption: "🔒 *SERVICIO TEMPORALMENTE CERRADO* 🔒\n\n" +
                                        "EN UN MOMENTO LES ENVIAMOS SU CORTE"
                                });

                                enviados++;
                                console.log(`✅ Mensaje CERRADO enviado a ${tipo}: ${formatearNumero(destinatario)} (${enviados}/${totalDestinatarios})`);

                                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 segundos
                            } catch (error) {
                                errores++;
                                console.log(`❌ Error enviando CERRADO a ${tipo}: ${error.message}`);
                            }
                        };

                        // Enviar a autorizados
                        for (const autorizado of autorizados) {
                            if (autorizado && autorizado.remitente_id) {
                                const tipo = autorizado.tipo_remitente === 'grupo' ? 'Grupo autorizado' : 'Usuario autorizado';
                                await enviarConDelay(autorizado.remitente_id, tipo);
                            }
                        }

                        // Enviar a no autorizados
                        for (const usuario of usuariosNoAutorizados) {
                            if (usuario) {
                                await enviarConDelay(usuario, 'Usuario no autorizado');
                            }
                        }

                        // Reporte final
                        await client.sendMessage(remitente,
                            `📊 *Reporte de envío CERRADO completado*\n\n` +
                            `✅ Enviados exitosamente: ${enviados}\n` +
                            `❌ Errores: ${errores}\n` +
                            `📱 Total destinatarios: ${totalDestinatarios}\n\n` +
                            `⏰ Tiempo estimado: ${Math.ceil(totalDestinatarios * 2 / 60)} minutos`
                        );

                    } catch (error) {
                        console.error('❌ Error crítico en comando cerrado:', error);
                        console.error('Stack trace:', error.stack);

                        // Envío detallado del error al administrador
                        await client.sendMessage(remitente,
                            `❌ Error ejecutando comando cerrado:\n\n` +
                            `Error: ${error.message}\n` +
                            `Tipo: ${error.name}\n\n` +
                            `Verifica:\n` +
                            `1. Conexión a base de datos\n` +
                            `2. Imagen cerrado.jpg en carpeta raíz\n` +
                            `3. Permisos de archivos`
                        );
                    }
                    return;
                }

                // COMANDO: limpiar curps
                if (comandoLower === "limpiar curps") {
                    const antes = await contarIdentificadoresPendientes();
                    const eliminadas = await limpiarCURPsExpiradas();
                    const despues = await contarIdentificadoresPendientes();

                    await client.sendMessage(remitente,
                        `🧹 Limpieza manual completada:\n• Antes: ${antes} CURPs\n• Después: ${despues} CURPs\n• Eliminadas: ${eliminadas}`
                    );
                    return;
                }
            }

            // Detectar y registrar automáticamente si es un grupo
            if (esGrupo(remitente)) {
                try {
                    const chat = await message.getChat();
                    if (chat.isGroup) {
                        await guardarGrupo(
                            chat.id._serialized,
                            chat.name || `Grupo: ${formatearNumero(chat.id._serialized)}`,
                            chat.participants?.length || 0
                        );
                    }
                } catch (error) {
                    console.error(`Error al registrar grupo ${remitente}:`, error);
                }
            }

            // Extraer identificadores válidos, inválidos e incompletos
            const resultados = extraerIdentificadores(texto);
            const validos = resultados.validos || [];
            const invalidos = resultados.invalidos || [];
            const incompletos = resultados.incompletos || [];

            // Responder específicamente a CURPs incompletas
            if (incompletos.length > 0 && validos.length === 0) {
                let mensajeIncompleto = `⚠️ *CURP incompleta detectada*\n\n`;

                const curpIncompleta = incompletos[0];

                // Verificar si es CURP (empieza con letras) o código numérico
                if (/^[A-Z]{4}/.test(curpIncompleta)) {
                    mensajeIncompleto += `La CURP "${curpIncompleta}" está incompleta.\n\n` +
                        `✅ *Formato correcto de CURP:*\n` +
                        `• Debe tener exactamente 18 caracteres\n` +
                        `• 4 letras + 6 números + 6 letras + 2 caracteres\n` +
                        `• Ejemplo: MARS850101HDFLRN02\n\n` +
                        `❌ Tu CURP tiene ${curpIncompleta.length} caracteres (faltan ${18 - curpIncompleta.length})\n\n`;
                } else if (/^\d+$/.test(curpIncompleta)) {
                    mensajeIncompleto += `El código "${curpIncompleta}" está incompleto.\n\n` +
                        `✅ *Formato correcto de código:*\n` +
                        `• Debe tener exactamente 20 números\n` +
                        `• Solo números, sin letras ni espacios\n` +
                        `• Ejemplo: 12345678901234567890\n\n` +
                        `❌ Tu código tiene ${curpIncompleta.length} números (faltan ${20 - curpIncompleta.length})\n\n`;
                }

                mensajeIncompleto += `📝 Por favor verifica los datos y envía completo.`;

                await client.sendMessage(remitente, mensajeIncompleto);
                return;
            }

            // Solo mostrar mensaje de inválidos si NO hay incompletos detectados
            if (validos.length === 0 && incompletos.length === 0) {
                if (invalidos.length > 0) {
                    const mensajeInvalidos = `⚠️ Los siguientes identificadores son inválidos:\n${invalidos.join('\n')}\n\nAsegúrate de que cada CURP tenga 18 caracteres y siga el formato correcto, o que cada cadena tenga exactamente 20 dígitos.`;
                    await client.sendMessage(remitente, mensajeInvalidos);
                }
                return;
            }

            // Determinar tipo de acta y opciones ANTES de verificar autorización
            const tipoActa = determinarTipoActa(texto);
            const marcoPorTexto = texto.toLowerCase().includes('marco');
            const marcoPorConfiguracion = await debeEnmarcarAutomaticamente(remitente);
            const contieneMarco = marcoPorTexto || marcoPorConfiguracion;

            const contieneFolio = texto.toLowerCase().includes('folio');
            if (marcoPorConfiguracion) {
                console.log(`📝 ${await getNombreGrupo(remitente)} tiene enmarcado automático configurado`);
            }
            const datosActa = {
                tipoActa: tipoActa,
                solicitaMarco: contieneMarco,
                solicitaFolio: contieneFolio,
                esGrupoAutoMarco: await debeEnmarcarAutomaticamente(remitente)

            };

            // Verificar si está autorizado
            const autorizado = await estaAutorizado(remitente);

            // Registrar TODAS las solicitudes (autorizadas o no)
            for (const identificador of validos) {
                await registrarSolicitud(identificador, remitente, autorizado, datosActa);

                // Solo agregar al mapa de procesamiento si está autorizado
                if (autorizado) {
                    await agregarIdentificadorRemitente(identificador, {
                        remitente: remitente,
                        tipoActa: tipoActa,
                        solicitaMarco: contieneMarco,
                        solicitaFolio: contieneFolio,
                        esGrupoAutoMarco: await debeEnmarcarAutomaticamente(remitente),
                        intentos: 0
                    });
                }
            }

            // Manejar usuarios NO autorizados
            if (!autorizado) {
                await client.sendMessage(remitente,
                    "❌ No tienes autorización para solicitar documentos. Tu solicitud ha sido registrada para revisión del administrador."
                );

                // Notificar a los administradores
                const mensajeAdmin = `🚫 *Solicitud no autorizada registrada*\n\nUsuario: ${await getNombreGrupo(remitente)}\nMensaje: ${texto}\nIdentificadores: ${validos.join(', ')}\n\n✅ La solicitud fue guardada para revisión.`;
                await notificarAdmins(client, mensajeAdmin);
                return;
            }

            // Reenviar el mensaje a todos los administradores
            if (!(await esAdmin(remitente)) && validos.length > 0) {
                await notificarAdmins(client, `\n${texto}`);
            }

            // Responder al usuario
            if (validos.length > 0) {
                try {
                    let mensaje = `procesando..`;
                    const tieneEnmarcadoAutomatico = await debeEnmarcarAutomaticamente(remitente);
                    // const tieneApiAutomatica = await esGrupoEspecial(remitente);

                    if (tieneEnmarcadoAutomatico || marcoPorTexto) {
                        mensaje = `Procesando con enmarcado automático...`;
                        if (contieneFolio) {
                            mensaje += ` (con folio)`;
                        }
                    }

                    // if (tieneApiAutomatica) {
                    //   mensaje += ` [URL disponible al finalizar]`;
                    // }
                    await client.sendMessage(remitente, mensaje);
                } catch (error) {
                    console.error(`Error al enviar confirmación: ${error.message}`);
                }
            }

        } catch (error) {
            console.error('Error al procesar mensaje:', error);
        }
    });

    // Monitoreo de salud del bot cada 5 minutos
    setInterval(async () => {
        if (colaArchivos.length > 0 || procesandoCola) {
            console.log(`📊 Estado cola: ${colaArchivos.length} archivos pendientes, procesando: ${procesandoCola ? 'SÍ' : 'NO'}`);

            if (colaArchivos.length > 0) {
                console.log(`🔍 Archivos en cola: ${colaArchivos.join(', ')}`);
            }
        }

        // Ejecutar limpieza y procesamiento de eliminaciones
        await limpiarCURPsExpiradas();
        await procesarEliminacionesPendientes();
        await limpiarArchivosTemporales(); // AGREGAR ESTA LÍNEA
    }, 5 * 60 * 1000); // 5 minutos

    // Inicializar cliente
    client.initialize();
}

// Iniciar la conexión

conectarWhatsApp();

