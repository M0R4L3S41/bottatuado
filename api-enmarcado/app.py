# app.py - API Flask integrada para el bot de WhatsApp
from flask import Flask, request, jsonify, send_file
import os
import tempfile
from werkzeug.utils import secure_filename
from enmarcado import overlay_pdf_on_background
from io import BytesIO
import traceback
from datetime import datetime  # AGREGAR ESTA LÍNEA
import os
from flask_cors import CORS


app = Flask(__name__)
CORS(app, origins=['*'])  # Permitir CORS para Railway
PORT = int(os.environ.get('PORT', 5000))  # Puerto dinámico de Railway
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

@app.route('/api/mensaje_whatsapp', methods=['POST'])
def procesar_mensaje_whatsapp():
    """
    Endpoint para procesar mensajes del bot de WhatsApp con enmarcado
    """
    try:
        data = request.get_json()
        
        # Validar datos requeridos
        if not data:
            print("❌ No se recibieron datos JSON")
            return jsonify({
                'success': False,
                'message': 'No se recibieron datos JSON'
            }), 400
        
        # Extraer información del mensaje
        mensaje = data.get('mensaje', '').lower()
        remitente = data.get('remitente', '')
        nombre = data.get('nombre', 'Usuario')
        archivo_original = data.get('archivo_original', '')
        tipo_acta = data.get('tipo_acta', 'nacimiento')
        aplicar_folio = data.get('aplicar_folio', False)
        es_grupo_auto_marco = data.get('esGrupoAutoMarco', False)
        
        print(f"📨 Procesando solicitud de enmarcado:")
        print(f"   Mensaje: {mensaje}")
        print(f"   Remitente: {remitente}")
        print(f"   Archivo: {archivo_original}")
        print(f"   Tipo acta: {tipo_acta}")
        print(f"   Aplicar folio: {aplicar_folio}")
        print(f"   Es grupo auto marco: {es_grupo_auto_marco}")
        
        # Verificar que el archivo existe
        if not archivo_original or not os.path.exists(archivo_original):
            print(f"❌ Archivo no encontrado: {archivo_original}")
            return jsonify({
                'success': False,
                'message': f'Archivo no encontrado: {archivo_original}'
            }), 404
        
        # Determinar opciones de enmarcado basado en el mensaje
        opciones_enmarcado = determinar_opciones_enmarcado(mensaje, aplicar_folio, es_grupo_auto_marco)
        
        print(f"🖼️ Opciones de enmarcado determinadas: {opciones_enmarcado}")
        
        # Procesar el archivo con enmarcado
        resultado = procesar_archivo_con_enmarcado(archivo_original, opciones_enmarcado)
        
        if resultado['success']:
            print(f"✅ Enmarcado exitoso: {resultado['pdf_path']}")
            return jsonify({
                'success': True,
                'message': 'Documento enmarcado exitosamente',
                'pdf_path': resultado['pdf_path'],
                'opciones_aplicadas': opciones_enmarcado
            })
        else:
            print(f"❌ Error en enmarcado: {resultado['message']}")
            return jsonify({
                'success': False,
                'message': resultado['message']
            }), 500
            
    except Exception as e:
        print(f"❌ Error en procesar_mensaje_whatsapp: {str(e)}")
        print(traceback.format_exc())
        return jsonify({
            'success': False,
            'message': f'Error interno del servidor: {str(e)}'
        }), 500

def determinar_opciones_enmarcado(mensaje, aplicar_folio, es_grupo_auto_marco):
    """
    Determina las opciones de enmarcado basado en el mensaje y configuraciones
    """
    opciones = {
        'apply_front': False,
        'apply_rear': False,
        'apply_folio': False,
        'only_first_page': False
    }
    
    print(f"🔍 Analizando mensaje: '{mensaje}'")
    print(f"🔍 Aplicar folio: {aplicar_folio}")
    print(f"🔍 Es grupo auto marco: {es_grupo_auto_marco}")
    
    # Si es del grupo auto marco, siempre aplicar enmarcado completo
    if es_grupo_auto_marco:
        opciones['apply_front'] = True
        opciones['apply_rear'] = True
        opciones['apply_folio'] = aplicar_folio
        print(f"✅ Grupo auto marco - aplicando enmarcado completo")
        return opciones
    
    # Analizar el mensaje para determinar opciones
    if 'marco' in mensaje:
        opciones['apply_front'] = True
        opciones['apply_rear'] = True
        print(f"✅ Palabra 'marco' encontrada - aplicando marcos frontal y trasero")
        
        # Si menciona folio o se especifica aplicar_folio
        if 'folio' in mensaje or aplicar_folio:
            opciones['apply_folio'] = True
            print(f"✅ Folio solicitado")
    
    # Opciones específicas adicionales
    if 'solo primera' in mensaje or 'primera página' in mensaje:
        opciones['only_first_page'] = True
        print(f"✅ Solo primera página")
    
    if 'delantero' in mensaje or 'frontal' in mensaje:
        opciones['apply_front'] = True
        print(f"✅ Marco frontal solicitado")
    
    if 'trasero' in mensaje or 'posterior' in mensaje:
        opciones['apply_rear'] = True
        print(f"✅ Marco trasero solicitado")
    
    print(f"📋 Opciones finales: {opciones}")
    return opciones

def procesar_archivo_con_enmarcado(archivo_original, opciones):
    """
    Procesa el archivo PDF aplicando las opciones de enmarcado especificadas
    """
    try:
        # Crear nombre de archivo de salida
        directorio_origen = os.path.dirname(archivo_original)
        nombre_archivo = os.path.basename(archivo_original)
        nombre_sin_extension = os.path.splitext(nombre_archivo)[0]
        archivo_salida = os.path.join(directorio_origen, f"enmarcado_{nombre_archivo}")
        
        print(f"📁 Procesando archivo: {archivo_original}")
        print(f"📁 Archivo de salida: {archivo_salida}")
        print(f"📋 Opciones: {opciones}")
        
        # Verificar archivos de marco necesarios
        background_pdf = "static/marcoparaactas.pdf"
        marcos_folder = "static/marcostraceros"
        
        if opciones['apply_front'] and not os.path.exists(background_pdf):
            return {
                'success': False,
                'message': f'Archivo de marco frontal no encontrado: {background_pdf}'
            }
        
        if opciones['apply_rear'] and not os.path.exists(marcos_folder):
            return {
                'success': False,
                'message': f'Carpeta de marcos traseros no encontrada: {marcos_folder}'
            }
        
        # Simular objeto de archivo para la función de enmarcado
        class MockFileObject:
            def __init__(self, file_path):
                self.file_path = file_path
                self.filename = os.path.basename(file_path)
            
            def read(self):
                with open(self.file_path, 'rb') as f:
                    return f.read()
        
        # Crear objeto mock del archivo
        mock_file = MockFileObject(archivo_original)
        
        # Stream de salida
        output_stream = BytesIO()
        
        print(f"🔄 Iniciando overlay_pdf_on_background...")
        
        # Aplicar enmarcado usando la función existente
        success, message = overlay_pdf_on_background(
            mock_file,
            output_stream,
            opciones['apply_front'],
            opciones['apply_rear'],
            opciones['apply_folio'],
            opciones.get('only_first_page', False)
        )
        
        print(f"📊 Resultado overlay: success={success}, message='{message}'")
        
        if success:
            # Guardar el archivo procesado
            output_stream.seek(0)
            with open(archivo_salida, 'wb') as f:
                f.write(output_stream.getvalue())
            
            print(f"✅ Archivo enmarcado guardado en: {archivo_salida}")
            
            return {
                'success': True,
                'pdf_path': archivo_salida,
                'message': 'Archivo procesado correctamente'
            }
        else:
            print(f"❌ Error en overlay_pdf_on_background: {message}")
            return {
                'success': False,
                'message': f'Error en enmarcado: {message}'
            }
            
    except Exception as e:
        print(f"❌ Error procesando archivo: {str(e)}")
        print(traceback.format_exc())
        return {
            'success': False,
            'message': f'Error procesando archivo: {str(e)}'
        }

@app.route('/api/test', methods=['GET'])
def test_api():
    """Endpoint de prueba para verificar que la API está funcionando"""
    return jsonify({
        'success': True,
        'message': 'API de enmarcado funcionando correctamente',
        'timestamp': str(datetime.now())
    })

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'service': 'enmarcado-api'
    })

@app.route('/', methods=['GET'])
def root():
    """Endpoint raíz para verificar que el servidor está corriendo"""
    return jsonify({
        'status': 'running',
        'service': 'enmarcado-api',
        'endpoints': [
            '/api/mensaje_whatsapp',
            '/api/test',
            '/health'
        ]
    })

if __name__ == '__main__':
    print("🚀 Iniciando API de enmarcado en Railway...")
    print("📂 Verificando archivos necesarios...")
    
    # Verificar archivos de marco
    if os.path.exists("static/marcoparaactas.pdf"):
        print("✅ Marco frontal encontrado")
    else:
        print("❌ Marco frontal NO encontrado: static/marcoparaactas.pdf")
    
    if os.path.exists("static/marcostraceros"):
        marcos = os.listdir("static/marcostraceros")
        print(f"✅ Marcos traseros encontrados: {len(marcos)} archivos")
    else:
        print("❌ Carpeta marcos traseros NO encontrada: static/marcostraceros")
    
    print(f"🌐 Servidor iniciando en puerto {PORT} (Railway)")
    app.run(host='0.0.0.0', port=PORT, debug=False)
