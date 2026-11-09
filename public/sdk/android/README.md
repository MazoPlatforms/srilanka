# Sri Lanka Map — Android SDK

Kotlin SDK and integration guide for embedding Sri Lanka streets, vector tiles (PBF), raster tiles (PNG), and routing into Android apps using **MapLibre Android SDK** or **Google Maps Android SDK**.

---

## Google Maps Android SDK Integration (Raster PNG Tiles)

If your app already uses **Google Maps Android SDK** (`com.google.android.gms:play-services-maps`), you can display all Sri Lanka streets by adding a custom `TileOverlay` powered by this tile server.

### 1. Add Google Maps Dependency

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("com.google.android.gms:play-services-maps:18.2.0")
}
```

### 2. Add TileOverlay in Activity

```kotlin
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.OnMapReadyCallback
import com.google.android.gms.maps.model.TileOverlayOptions
import com.google.android.gms.maps.model.UrlTileProvider
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.LatLng
import java.net.URL

class GoogleMapsActivity : AppCompatActivity(), OnMapReadyCallback {

    override fun onMapReady(googleMap: GoogleMap) {
        val serverUrl = "http://10.0.2.2:8080" // Use 10.0.2.2 for Android Emulator, or your server URL

        val tileProvider = object : UrlTileProvider(256, 256) {
            override fun getTileUrl(x: Int, y: Int, zoom: Int): URL? {
                return try {
                    URL("$serverUrl/tiles/$zoom/$x/$y.png")
                } catch (e: Exception) {
                    null
                }
            }
        }

        // Add Sri Lanka streets overlay
        googleMap.addTileOverlay(
            TileOverlayOptions()
                .tileProvider(tileProvider)
                .fadeIn(true)
        )

        // Center on Sri Lanka
        googleMap.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(7.87, 80.70), 8f))
    }
}
```

---

## MapLibre Android SDK Integration (Vector PBF Tiles)

For full interactive client-side styling, dynamic street class toggling, and 3D buildings, use the **MapLibre Android SDK**.

---

## Requirements

| Dependency | Version |
|------------|---------|
| Android minSdk | 24 (Android 7.0) |
| MapLibre Android SDK | 11.x |
| Kotlin | 1.9+ |
| Coroutines | 1.7+ |

---

## Gradle Setup

Add the MapLibre Maven repository and dependencies to your `build.gradle.kts`:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://artifacts.maplibre.org/repository/maven-releases/")
    }
}
```

```kotlin
// app/build.gradle.kts
dependencies {
    // MapLibre Android SDK
    implementation("org.maplibre.gl:android-sdk:11.0.1")

    // Coroutines (for async search/routing)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
```

Copy the following files from this directory into your app module:
- `MapConfig.kt` → `app/src/main/java/com/srilanka/map/`
- `SriLankaMapHelper.kt` → same package
- `TileServerClient.kt` → same package

---

## Quick Start

### 1. Add MapView to your layout

```xml
<!-- res/layout/activity_map.xml -->
<org.maplibre.android.maps.MapView
    android:id="@+id/mapView"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    app:maplibre_cameraTargetLat="7.87"
    app:maplibre_cameraTargetLng="80.70"
    app:maplibre_cameraZoom="8" />
```

### 2. Initialise in Activity/Fragment

```kotlin
class MapActivity : AppCompatActivity() {

    private lateinit var mapView: MapView
    private lateinit var helper: SriLankaMapHelper

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Initialise MapLibre (required before setContentView)
        MapLibre.getInstance(this)

        setContentView(R.layout.activity_map)
        mapView = findViewById(R.id.mapView)
        mapView.onCreate(savedInstanceState)

        // Configure tile server (use MapConfig.local() for the emulator)
        val config = MapConfig.local()          // → http://10.0.2.2:8080
        // val config = MapConfig.production("https://your-server.example.com")

        helper = SriLankaMapHelper(this, mapView, config)

        mapView.getMapAsync { map ->
            helper.setup(map) {
                // Map is ready — show major road classes
                helper.showStreets(listOf("motorway", "trunk", "primary", "secondary"))
            }
        }
    }

    // ---- Routing (call from a coroutine) ----
    private fun showRoute() {
        lifecycleScope.launch {
            val result = helper.getRoute(
                start = LatLng(6.9271, 79.8612),   // Colombo
                end   = LatLng(7.2906, 80.6337),   // Kandy
                mode  = "car",
            )
            result?.let { helper.drawRoute(it) }
        }
    }

    // ---- Place search (call from a coroutine) ----
    private fun search(query: String) {
        lifecycleScope.launch {
            val results = helper.searchPlaces(query, limit = 8)
            results.forEach { r ->
                Log.d("Search", "${r.name} @ ${r.latitude},${r.longitude}")
            }
        }
    }

    // ---- Lifecycle ----
    override fun onStart()   { super.onStart();   mapView.onStart() }
    override fun onResume()  { super.onResume();  mapView.onResume() }
    override fun onPause()   { super.onPause();   mapView.onPause() }
    override fun onStop()    { super.onStop();    mapView.onStop() }
    override fun onDestroy() { super.onDestroy(); mapView.onDestroy() }
    override fun onSaveInstanceState(state: Bundle) {
        super.onSaveInstanceState(state); mapView.onSaveInstanceState(state)
    }
    override fun onLowMemory() { super.onLowMemory(); mapView.onLowMemory() }
}
```

---

## API Reference

### `MapConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `tileServerBaseUrl` | `String` | `http://localhost:8080` | Tile server base URL |
| `styleUrl` | `String` | `{base}/style.json` | MapLibre GL style JSON |
| `routingEndpoint` | `String` | `{base}/routing` | Routing API base |
| `searchEndpoint` | `String` | `{base}/streets` | Streets/search API base |
| `maxZoom` | `Double` | `14.0` | Max zoom level |
| `minZoom` | `Double` | `6.0` | Min zoom level |
| `defaultCenter` | `DoubleArray` | `[80.7, 7.87]` | Initial map centre |
| `defaultZoom` | `Double` | `8.0` | Initial zoom level |
| `enableBuildings` | `Boolean` | `true` | 3D buildings at zoom 15+ |
| `enableRouting` | `Boolean` | `true` | Routing integration |

### `SriLankaMapHelper`

| Method | Description |
|--------|-------------|
| `setup(map, onReady)` | Load style + sources; call `onReady` when done |
| `showStreets(classes)` | Add/show layers for given road classes |
| `hideStreets(classes)` | Hide (but retain) layers for given classes |
| `addStreetLayer(map, class)` | Add a single road-class layer across all districts |
| `searchPlaces(query, limit)` | Suspend: search places by name |
| `getRoute(start, end, mode)` | Suspend: compute A* route |
| `drawRoute(result)` | Render route polyline on map |
| `clearRoute()` | Remove route polyline |

### `TileServerClient`

| Method | Description |
|--------|-------------|
| `getStreetsIndex()` | Fetch `streets/index.json` |
| `getStreetClass(cls)` | Fetch `streets/by-class/{cls}.json` |
| `getStreetDistrict(slug)` | Fetch `streets/by-district/{slug}.json` |
| `getRoutingManifest()` | Fetch `routing/manifest.json` |
| `searchPlaces(query, limit)` | Search place shards |
| `getRoute(start, end, mode)` | Request route JSON |
| `isHealthy()` | Ping `/health` endpoint |

---

## Road Classes

| Class | Colour | Allowed Modes |
|-------|--------|---------------|
| `motorway` | 🔴 `#ee4444` | car, motorcycle, truck, bus |
| `trunk` | 🟠 `#ff8800` | all |
| `primary` | 🟡 `#f6cf8a` | all |
| `secondary` | `#ffffdd` | all |
| `tertiary` | `#ffffee` | all |
| `residential` | white | all light vehicles |
| `footway` | grey | foot, wheelchair |
| `cycleway` | 🔵 `#66aaff` | bike, foot |
| `track` | brown | all |
| `ferry` | 🩵 `#00aaff` | all |

---

## Running the Tile Server Locally

```bash
# Install Python dependency
pip install pmtiles

# Start the server (from repo root)
python scripts/tile_server.py --port 8080 --public public

# Test health endpoint
curl http://localhost:8080/health
```

For Android Emulator, use `10.0.2.2:8080` to reach the host machine. Use `MapConfig.local()`.

---

## Permissions

Add to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<!-- Optional: for GeolocateControl -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```
