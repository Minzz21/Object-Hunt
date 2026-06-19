from flask import Flask, request, jsonify, render_template
import requests as req_lib

app = Flask(__name__)

API_URL = "https://telkom-ai-dag.api.apilogy.id/Object_Detection/0.0.1/v1"
API_HEADERS = {
    "accept": "application/json",
    "x-api-key": "wCZJrRvULd3RO3Ib0Qv5CrkOQfVf97QA"
}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/detect', methods=['POST'])
def detect():
    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files['file']
    try:
        files = {"file": (f.filename or "frame.jpg", f.read(), f.content_type or "image/jpeg")}
        response = req_lib.post(API_URL, headers=API_HEADERS, files=files, timeout=6)
        if response.status_code == 200:
            result = response.json()
            # DEBUG: print raw response structure
            import json
            print("[DEBUG] Raw API response:", json.dumps(result, indent=2)[:1000])
            # Filter out 'person' detections
            if isinstance(result.get('data'), list):
                result['data'] = [
                    {k: v for k, v in item.items() if k.lower() != 'person'}
                    for item in result['data']
                ]
            print("[DEBUG] After filter:", json.dumps(result.get('data'), indent=2)[:500])
            return jsonify(result)
        return jsonify({"error": f"API {response.status_code}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000, host='0.0.0.0')
