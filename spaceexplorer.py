import os
import time
import json
import urllib.request
from pathlib import Path
import pandas as pd
import re
from playwright.sync_api import sync_playwright

# ==============================================================================
# CONFIGURATION & PATHS
# ==============================================================================
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
PUBLIC_DATA_DIR = BASE_DIR / "public" / "data"
PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)

MAPPING_JSON_PATH = DATA_DIR / "mapping.json"
META_JSON_PATH = PUBLIC_DATA_DIR / "meta.json"
GLOBE_JSON_PATH = PUBLIC_DATA_DIR / "globe.json"
STATIONS_JSON_PATH = PUBLIC_DATA_DIR / "stations.json"
SATELLITES_JSON_PATH = PUBLIC_DATA_DIR / "satellites.json"
CONNECTIONS_JSON_PATH = PUBLIC_DATA_DIR / "connections.json"
HEADLESS_MODE = True  # Set to False to watch it run locally

# ==============================================================================
# STEP 1: AUTOMATED BROWSER DOWNLOAD & META SCRAPING
# ==============================================================================
def download_itu_file():
    print("Launching browser to automate ITU Space Explorer download...")
    br_ific_text = "Unknown Version"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS_MODE)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        url = "https://www.itu.int/itu-r/space/apps/public/spaceexplorer/networks-explorer/earth-stations"
        print(f"Navigating to {url}...")
        page.goto(url, timeout=60000)

        print("Waiting for page elements to load...")
        page.wait_for_load_state("networkidle")
        time.sleep(3)

        # Extract BR IFIC Version text from the UI
        try:
            print("Looking for BR IFIC version info on page...")
            ific_el = page.locator("text=/BR IFIC/i").first
            if ific_el.count() > 0:
                br_ific_text = ific_el.inner_text().strip()
                print(f"Found version string: {br_ific_text}")
        except Exception as e:
            print(f"Notice: Could not automatically scrape BR IFIC text ({e}).")

        # Save version metadata
        meta_data = {"br_ific": br_ific_text}
        with open(META_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(meta_data, f, indent=2, ensure_ascii=False)
        print(f"Saved version metadata to: {META_JSON_PATH}")

        # Dismiss any Reactour tutorials/popups blocking pointer events
        try:
            print("Checking for UI tour overlays or popups...")
            page.keyboard.press("Escape")
            time.sleep(1)
            for text_lbl in ["Skip", "Close", "Got it"]:
                close_btn = page.locator(f"button:has-text('{text_lbl}')")
                if close_btn.count() > 0 and close_btn.first.is_visible():
                    close_btn.first.click()
                    print(f"Dismissed popup via '{text_lbl}' button.")
                    time.sleep(0.5)
        except Exception as e:
            print(f"Popup check notice: {e}")

        # Uncheck Non-Geostationary filter if present
        try:
            print("Locating and unchecking 'Non-Geostationary'...")
            ngo_checkbox = page.locator("text=Non-Geostationary").locator("xpath=..//input[@type='checkbox']")
            if ngo_checkbox.is_visible() and ngo_checkbox.is_checked():
                ngo_checkbox.click(force=True)
                print("Successfully unchecked 'Non-Geostationary'.")
        except Exception as e:
            print(f"Notice: Non-Geostationary toggle skipped ({e}).")

        # Click Export safely
        print("Clicking export button...")
        export_btn = page.get_by_role("button", name="Export").first
        if export_btn.count() == 0:
            export_btn = page.locator("text=Export").first
        export_btn.click(force=True)
        time.sleep(1.5)

        # Select the exact .CSV (all frequency bands) option
        print("Selecting '.csv (all frequency bands)' option...")
        csv_option = page.locator("text=/csv.*all frequency bands/i").first
        if csv_option.count() == 0:
            csv_option = page.locator("text=all frequency bands").filter(has_text=re.compile("csv", re.IGNORECASE)).first

        with page.expect_download() as download_info:
            csv_option.click()
        
        download = download_info.value
        download_path = DATA_DIR / download.suggested_filename
        download.save_as(download_path)
        print(f"Successfully downloaded file to: {download_path}")

        browser.close()
        return download_path

# ==============================================================================
# STEP 2: DOWNLOAD GEOJSON BOUNDARIES
# ==============================================================================
def download_globe_geojson():
    print("Downloading GeoJSON world boundaries...")
    GEOJSON_URL = "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json"
    try:
        with urllib.request.urlopen(GEOJSON_URL) as response:
            geojson_data = json.load(response)
        with open(GLOBE_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(geojson_data, f)
        print(" Saved: globe.json")
    except Exception as e:
        print(f" Failed to fetch GeoJSON: {e}")

# ==============================================================================
# STEP 3: DIRECT CSV POST-PROCESSING & JSON GENERATION
# ==============================================================================
def process_file(file_path):
    print(f"\nPost-processing downloaded dataset: {file_path}")
    
    if file_path.suffix.lower() == '.xlsx':
        df = pd.read_excel(file_path)
    else:
        try:
            df = pd.read_csv(file_path, low_memory=False)
        except UnicodeDecodeError:
            df = pd.read_csv(file_path, encoding='latin1', low_memory=False)

    df.columns = df.columns.str.strip()

    # Load the unified mapping JSON file
    if not MAPPING_JSON_PATH.exists():
        raise FileNotFoundError(f"Mapping JSON file missing at: {MAPPING_JSON_PATH}. Please generate it first.")

    print(f"Loading mapping dictionary from: {MAPPING_JSON_PATH}")
    with open(MAPPING_JSON_PATH, "r", encoding="utf-8") as f:
        mapping_dict = json.load(f)

    def get_formatted_country(val):
        if pd.isna(val) or not val:
            return "Unknown"
        val_str = str(val).strip()
        
        # 1. Direct lookup by code (e.g. 'USA', 'AFS')
        entry = mapping_dict.get(val_str)
        if entry and isinstance(entry, dict):
            return entry.get("formatted", val_str)
            
        # 2. Lookup by matching country name value
        for code, data in mapping_dict.items():
            if data.get("country", "").lower() == val_str.lower():
                return data.get("formatted", val_str)
                
        return val_str

    # --- A. Save Processed CSV Backup ---
    for col in ['ctry', 'adm__ntwk_org', 'sat_adm__sat_ntwk_org']:
        if col in df.columns:
            df[f"{col}_normalized"] = df[col].apply(get_formatted_country)

    output_csv_path = DATA_DIR / "stations_processed.csv"
    df.to_csv(output_csv_path, index=False)
    print(f" Saved backup CSV at: {output_csv_path}")

    # --- B. Export stations.json ---
    print("Generating stations.json...")
    df_gs = df.dropna(subset=['lat_dec', 'long_dec']).copy()
    df_gs = df_gs[(df_gs['lat_dec'].between(-90, 90)) & (df_gs['long_dec'].between(-180, 180))]
    
    stations_df = df_gs[['stn_name', 'ctry', 'adm__ntwk_org', 'lat_dec', 'long_dec']].drop_duplicates()
    stations = [
        {
            "name": str(r["stn_name"]) if pd.notna(r["stn_name"]) else "Unknown",
            "country": get_formatted_country(r["ctry"]),
            "operator": get_formatted_country(r["adm__ntwk_org"]),
            "lat": float(r["lat_dec"]),
            "lon": float(r["long_dec"])
        }
        for r in stations_df.to_dict(orient="records")
    ]
    with open(STATIONS_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(stations, f, indent=2, ensure_ascii=False)
    print(f" Saved: stations.json ({len(stations)} records) -> {STATIONS_JSON_PATH}")

    # --- C. Export satellites.json ---
    print("Generating satellites.json...")
    df_sats = df.dropna(subset=['sat_name', 'long_nom']).copy()
    sats_df = df_sats[['sat_name', 'long_nom', 'plan_nonplan', 'sat_adm__sat_ntwk_org']].drop_duplicates()
    satellites = [
        {
            "name": str(r["sat_name"]),
            "lon": float(r["long_nom"]),
            "planned": bool(r["plan_nonplan"]) if pd.notna(r["plan_nonplan"]) else False,
            "operator": get_formatted_country(r["sat_adm__sat_ntwk_org"])
        }
        for r in sats_df.to_dict(orient="records")
    ]
    with open(SATELLITES_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(satellites, f, indent=2, ensure_ascii=False)
    print(f" Saved: satellites.json ({len(satellites)} records) -> {SATELLITES_JSON_PATH}")

    # --- D. Export connections.json (with frequency bands & ntc_id) ---
    print("Generating connections.json with frequency bands and ntc_id...")
    df_conn = df.dropna(subset=['sat_name', 'long_nom', 'lat_dec', 'long_dec']).copy()
    df_conn = df_conn[(df_conn['lat_dec'].between(-90, 90)) & (df_conn['long_dec'].between(-180, 180))]

    connections_dict = {}
    for r in df_conn.to_dict(orient="records"):
        key = (str(r["stn_name"]), str(r["sat_name"]))
        
        f_from = r.get("freq_from")
        f_to = r.get("freq_to")
        freq_str = "N/A"
        try:
            if pd.notna(f_from) and pd.notna(f_to):
                val_from = float(f_from)
                val_to = float(f_to)
                if val_from == val_to:
                    freq_str = f"{val_from:g} MHz"
                else:
                    freq_str = f"{val_from:g} - {val_to:g} MHz"
            elif pd.notna(f_from):
                freq_str = f"{float(f_from):g} MHz"
            elif pd.notna(f_to):
                freq_str = f"{float(f_to):g} MHz"
        except Exception:
            pass

        ntc_id_val = r.get("ntc_id")
        ntc_str = str(ntc_id_val).strip() if pd.notna(ntc_id_val) else None

        if key not in connections_dict:
            connections_dict[key] = {
                "gs_name": str(r["stn_name"]),
                "sat_name": str(r["sat_name"]),
                "gs_lat": float(r["lat_dec"]),
                "gs_lon": float(r["long_dec"]),
                "sat_lon": float(r["long_nom"]),
                "frequency_bands": set(),
                "ntc_id": set()
            }
        
        if freq_str != "N/A":
            connections_dict[key]["frequency_bands"].add(freq_str)
        if ntc_str and ntc_str.lower() != "nan":
            connections_dict[key]["ntc_id"].add(ntc_str)

    connections = []
    for conn_data in connections_dict.values():
        conn_data["frequency_bands"] = sorted(list(conn_data["frequency_bands"]))
        conn_data["ntc_id"] = sorted(list(conn_data["ntc_id"]))
        connections.append(conn_data)

    with open(CONNECTIONS_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(connections, f, indent=2, ensure_ascii=False)
    print(f" Saved: connections.json ({len(connections)} aggregated link records) -> {CONNECTIONS_JSON_PATH}")

    print(f"\n🎉 All pipeline tasks successfully completed. Website data -> {PUBLIC_DATA_DIR}")

if __name__ == "__main__":
    latest_file = download_itu_file()
    download_globe_geojson()
    process_file(latest_file)