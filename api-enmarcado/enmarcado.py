from flask import Blueprint, render_template, request, send_file, jsonify, redirect, session
import fitz  # PyMuPDF para manejar PDFs
import qrcode
import os
from io import BytesIO
from PIL import Image
from datetime import datetime
import pytz
import random
from barcode import Code128
from barcode.writer import ImageWriter

# Crear el Blueprint para las funcionalidades de enmarcado
enmarcado_bp = Blueprint('enmarcado', __name__, url_prefix='/')

# Constantes
BACKGROUND_PDF_PATH = "static/marcoparaactas.pdf"
MARCOS_FOLDER = "static/marcostraceros"

# Diccionario de abreviaturas y estados
ESTADOS = {
    "AS": "AGUASCALIENTES", "BC": "BAJA CALIFORNIA", "BS": "BAJA CALIFORNIA SUR", "CC": "CAMPECHE",
    "CL": "COAHUILA", "CM": "COLIMA", "CS": "CHIAPAS", "CH": "CHIHUAHUA", "DF": "DISTRITO FEDERAL",
    "DG": "DURANGO", "GT": "GUANAJUATO", "GR": "GUERRERO", "HG": "HIDALGO", "JC": "JALISCO",
    "MC": "MÉXICO", "MN": "MICHOACÁN", "MS": "MORELOS", "NT": "NAYARIT", "NL": "NUEVO LEÓN",
    "OC": "OAXACA", "PL": "PUEBLA", "QT": "QUERÉTARO", "QR": "QUINTANA ROO", "SP": "SAN LUIS POTOSÍ",
    "SL": "SINALOA", "SR": "SONORA", "TC": "TABASCO", "TS": "TAMAULIPAS", "TL": "TLAXCALA",
    "VZ": "VERACRUZ", "YN": "YUCATÁN", "ZS": "ZACATECAS", "NE": "NACIDO EN EL EXTRANJERO"
}

# Definir la zona horaria de México
mexico_timezone = pytz.timezone('America/Mexico_City')

# Funciones auxiliares
def is_within_working_hours():
    """Verifica si la hora actual está dentro del horario de trabajo."""
    # Obtener la hora actual en UTC y convertirla a la zona horaria de México
    now = datetime.now(pytz.utc).astimezone(mexico_timezone)
    
    # Imprimir la hora actual del servidor en la zona horaria de México
    print(f"Hora actual del servidor (Hora México): {now.strftime('%Y-%m-%d %H:%M:%S')}")

    # Definir el horario de trabajo (9 AM a 5 PM)
    start_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_time = now.replace(hour=23, minute=59, second=59, microsecond=0)

    # Verificar si la hora actual está dentro del horario permitido
    return start_time <= now <= end_time

def generate_qr_code(text):
    """Genera un código QR en memoria y devuelve un objeto Pixmap de PyMuPDF."""
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=0,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill='black', back_color='white')

    # Convertir la imagen de QR a formato PNG utilizando Pillow
    img_byte_array = BytesIO()
    img.save(img_byte_array, format="PNG")
    img_byte_array.seek(0)

    # Crear un Pixmap de PyMuPDF desde el stream de bytes PNG
    qr_img_fitz = fitz.Pixmap(img_byte_array)
    
    return qr_img_fitz

def generate_barcode(text):
    """
    Genera un código de barras vectorial sin texto y lo devuelve como un objeto Pixmap de PyMuPDF.
    """
    try:
        # Usar PIL/Pillow para generar el código de barras
        writer = ImageWriter()
        writer.set_options({
            'write_text': False,
            'module_height': 15.0,
            'module_width': 0.2,
            'quiet_zone': 3.0
        })
        
        # Generar código de barras
        output = BytesIO()
        Code128(text, writer=writer).write(output)
        output.seek(0)
        
        # Abrir la imagen
        img = Image.open(output)
        
        # Recortar la parte inferior para eliminar cualquier espacio donde podría estar el texto
        width, height = img.size
        new_height = int(height * 0.6)  # Conservar solo el 60% superior
        img = img.crop((0, 0, width, new_height))
        
        # Redimensionar con algoritmo de alta calidad
        img = img.resize((390, 40), Image.LANCZOS)
        
        # Guardar con formato PNG sin compresión
        img_bytes = BytesIO()
        img.save(img_bytes, format="PNG", optimize=False, compression=0)
        img_bytes.seek(0)
        
        return fitz.Pixmap(img_bytes)
    except Exception as e:
        print(f"Error generando código de barras: {e}")
        return None

def overlay_pdf_on_background(pdf_file, output_stream, apply_front, apply_rear, apply_folio, only_first_page=False):
    """Superpone PDFs según las opciones seleccionadas."""
    try:
        # Leer el PDF subido en memoria
        try:
            selected_pdf = fitz.open(stream=pdf_file.read(), filetype="pdf")
        except Exception as e:
            return False, f"Error al cargar el archivo PDF: {e}"

        if len(selected_pdf) == 0:
            return False, "Error: El PDF cargado está vacío."

        output_pdf = fitz.open()

        # Si se selecciona el enmarcado delantero
        if apply_front:
            background_pdf = fitz.open(BACKGROUND_PDF_PATH)
            
            # Para cada página del PDF de origen
            for page_num in range(len(selected_pdf)):
                # Si solo_primera_pagina es True y no estamos en la primera página
                # simplemente copiamos la página original sin aplicar marco
                if only_first_page and page_num > 0:
                    selected_page = selected_pdf.load_page(page_num)
                    new_page = output_pdf.new_page(width=selected_page.rect.width, height=selected_page.rect.height)
                    new_page.show_pdf_page(new_page.rect, selected_pdf, page_num)
                else:
                    # Para la primera página o si no es solo_primera_pagina
                    # aplicamos el marco normalmente
                    if page_num < len(background_pdf):
                        background_page = background_pdf.load_page(page_num)
                        new_page = output_pdf.new_page(width=background_page.rect.width, height=background_page.rect.height)
                        new_page.show_pdf_page(new_page.rect, background_pdf, page_num)
                        if page_num < len(selected_pdf):
                            selected_page = selected_pdf.load_page(page_num)
                            new_page.show_pdf_page(new_page.rect, selected_pdf, page_num)
            
            background_pdf.close()
        else:
            # Si NO se selecciona el delantero, se agregan las páginas del PDF subido directamente
            for page_num in range(len(selected_pdf)):
                selected_page = selected_pdf.load_page(page_num)
                new_page = output_pdf.new_page(width=selected_page.rect.width, height=selected_page.rect.height)
                new_page.show_pdf_page(new_page.rect, selected_pdf, page_num)

        # Si se selecciona el enmarcado trasero y (no es solo primera página o solo hay una página)
        if apply_rear and (not only_first_page or len(selected_pdf) == 1):
            filename = os.path.basename(pdf_file.filename)
            state_abbr = filename[11:13].upper()
            if state_abbr in ESTADOS:
                state_pdf_path = os.path.join(MARCOS_FOLDER, f"{state_abbr}.pdf")
                if os.path.exists(state_pdf_path):
                    state_pdf = fitz.open(state_pdf_path)
                    for state_page_num in range(len(state_pdf)):
                        new_page = output_pdf.new_page(width=state_pdf[state_page_num].rect.width, height=state_pdf[state_page_num].rect.height)
                        new_page.show_pdf_page(new_page.rect, state_pdf, state_page_num)
                    state_pdf.close()

        # Insertar códigos QR en la segunda página (parte inferior izquierda) - solo si hay más de una página
        # y no es solo_primera_pagina o solo hay una página en el documento original
        if len(output_pdf) > 1 and (not only_first_page or len(selected_pdf) == 1):
            filename = os.path.basename(pdf_file.filename)
            qr_img = generate_qr_code(filename)
            second_page = output_pdf.load_page(1)
    
            # Extraer información de la CURP (ajustar según cómo obtienes la CURP)
            # Por ejemplo, si la CURP está en los primeros 18 caracteres del nombre:
            curp = filename[:18] if len(filename) >= 18 else filename
    
            # Definir tamaño y posición del QR superior más pequeño
            qr_size = 60  # Tamaño reducido del QR
            qr_x = 25     # Posición X del QR 
            qr_y = 30     # Posición Y del QR
    
            # Insertar QR superior con tamaño más pequeño
            qr_rect = fitz.Rect(qr_x, qr_y, qr_x + qr_size, qr_y + qr_size)
            second_page.insert_image(qr_rect, pixmap=qr_img)
    
            # Añadir CURP justo debajo del QR con el mismo ancho
            second_page.insert_text(
                (qr_x, qr_y + qr_size + 7),  # Posición justo debajo del QR
                curp,
                fontsize=5,
                fontname="helvetica-bold",
                color=(0.5, 0.5, 0.5)              # Color gris (valores entre 0 y 1)
            )
    
            # El segundo QR en la parte inferior izquierda
            page_height = second_page.rect.height
            qr_size_small = 17 * 2.83465  # Tamaño del segundo QR en puntos
            move_up = 5.33 * 2.83465      # Ajuste para mover el QR hacia arriba
            move_right = 4.26 * 2.83465   # Ajuste para mover el QR hacia la derecha
    
            qr_rect_bottom_left = fitz.Rect(
                20 + move_right,
                (page_height - qr_size_small - 10) - move_up,
                (20 + qr_size_small + move_right),
                (page_height - 10) - move_up
            )
            second_page.insert_image(qr_rect_bottom_left, pixmap=qr_img)

        # Insertar folio (si se selecciona) en la primera página con código de barras real
        if apply_folio:
            folio_random = random.randint(100000, 999999)
            barcode_text = "A30" + str(folio_random)  # Sin espacio para el código de barras

            first_page = output_pdf.load_page(0)
            first_page.insert_text((85, 48), "FOLIO", fontsize=14, fontname="times-bold", color=(0, 0, 0))
            first_page.insert_text((75, 65), "A30-" + str(folio_random), fontsize=12, fontname="times-bold", color=(0, 0, 0))

            # Generar código de barras sin texto
            barcode_img = generate_barcode(barcode_text)
            
            if barcode_img:
                # Insertar imagen del código de barras con alta calidad
                # Ajustar el tamaño y posición para mejor visualización
                rect = fitz.Rect(45, 72, 175, 87)
                
                # Usar método mejorado para inserción
                first_page.insert_image(
                    rect, 
                    pixmap=barcode_img,
                    keep_proportion=True,  # Mantener proporción
                    overlay=True  # Superponer sin modificar el fondo
                )

        output_pdf.save(output_stream)
        output_pdf.close()
        selected_pdf.close()
        return True, "PDF generado correctamente."

    except Exception as e:
        print(f"Error overlaying PDFs: {e}")
        return False, f"Error al generar el PDF: {e}"
# Rutas del Blueprint
@enmarcado_bp.route('/process_pdf', methods=['POST'])
def process_pdf():
    """Procesa el PDF según las opciones seleccionadas."""
    if not is_within_working_hours():
        return "El servicio no está disponible fuera del horario de 9 AM a 5 PM.", 403
    
    try:
        if 'pdf_file' not in request.files:
            print("No file in request.files")
            return 'No file uploaded', 400

        pdf_file = request.files['pdf_file']
        print(f"Archivo recibido: {pdf_file.filename}")
        
        if pdf_file.filename == '':
            print("No file selected")
            return 'No selected file', 400
        
        # Leer las opciones de enmarcado del formulario
        apply_front = True if request.form.get('front_frame') == 'on' else False
        apply_rear  = True if request.form.get('rear_frame')  == 'on' else False
        apply_folio = True if request.form.get('folio')       == 'on' else False

        output_stream = BytesIO()
        success, message = overlay_pdf_on_background(pdf_file, output_stream, apply_front, apply_rear, apply_folio)
        if not success:
            print(f"Error generando el PDF: {message}")
            return message, 500

        output_stream.seek(0)
        return send_file(output_stream, as_attachment=True, download_name=f"_{pdf_file.filename}", mimetype='application/pdf')

    except Exception as e:
        print(f"Error procesando PDF: {e}")
        return 'Error procesando archivo PDF', 500