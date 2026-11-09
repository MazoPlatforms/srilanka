package com.srilanka.map

import android.annotation.SuppressLint
import android.content.Context
import android.util.AttributeSet
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * SriLankaMapView — 100% Frontend-only Android Map Component
 * ==========================================================
 * Embeds the Sri Lanka Map directly into any Android Activity or Fragment
 * using an optimized WebView that connects directly to GitHub Pages.
 *
 * Requires ZERO backend servers, ZERO API keys.
 *
 * Features:
 *   - 100% hosted on GitHub Pages
 *   - Vector tiles (PMTiles) rendered client-side
 *   - Offline-capable tile caching via WebView HTTP cache
 *   - Two-way Kotlin <-> JavaScript bridge for routing and street filtering
 *
 * Usage:
 *   val mapView = findViewById<SriLankaMapView>(R.id.sriLankaMap)
 *   mapView.loadMap("https://MazoPlatforms.github.io/srilanka")
 *   mapView.onMapReady = {
 *       mapView.showStreets(listOf("motorway", "primary"))
 *       mapView.route(6.9271, 79.8612, 7.2906, 80.6337, "car")
 *   }
 */
class SriLankaMapView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : WebView(context, attrs, defStyleAttr) {

    var onMapReady: (() -> Unit)? = null
    var onRouteCalculated: ((distanceKm: Double, durationSec: Long) -> Unit)? = null
    var onPlaceSelected: ((name: String, lat: Double, lon: Double) -> Unit)? = null

    init {
        configureWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = true
            allowContentAccess = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
        }

        addJavascriptInterface(MapBridge(), "AndroidMapBridge")

        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // Notify map ready
                post { onMapReady?.invoke() }
            }
        }
    }

    /**
     * Load the map from GitHub Pages URL.
     * @param url Default is official GitHub Pages URL
     */
    fun loadMap(url: String = "https://MazoPlatforms.github.io/srilanka/") {
        loadUrl(url)
    }

    /**
     * Filter street classes displayed on the map.
     * @param classes e.g. listOf("motorway", "trunk", "primary")
     */
    fun showStreets(classes: List<String>) {
        val jsonArray = JSONArray(classes).toString()
        evaluateJavascript("if (window.__sdk) window.__sdk.showStreets($jsonArray);", null)
    }

    /**
     * Request client-side A* route between two points.
     */
    fun route(startLat: Double, startLon: Double, endLat: Double, endLon: Double, mode: String = "car") {
        val script = """
            if (window.__sdk) {
                window.__sdk.route({
                    from: [$startLon, $startLat],
                    to: [$endLon, $endLat],
                    mode: '$mode'
                }).then(r => {
                    if (r && window.AndroidMapBridge) {
                        window.AndroidMapBridge.onRoute(r.distance_km || 0, r.duration_sec || 0);
                    }
                });
            }
        """.trimIndent()
        evaluateJavascript(script, null)
    }

    /**
     * Clear active route polyline.
     */
    fun clearRoute() {
        evaluateJavascript("if (window.__sdk) window.__sdk.clearRoute();", null)
    }

    /**
     * Fly camera to location.
     */
    fun flyTo(lat: Double, lon: Double, zoom: Int = 14) {
        evaluateJavascript("if (window.__map) window.__map.flyTo({ center: [$lon, $lat], zoom: $zoom });", null)
    }

    inner class MapBridge {
        @JavascriptInterface
        fun onRoute(distanceKm: Double, durationSec: Long) {
            post { onRouteCalculated?.invoke(distanceKm, durationSec) }
        }

        @JavascriptInterface
        fun onPlace(name: String, lat: Double, lon: Double) {
            post { onPlaceSelected?.invoke(name, lat, lon) }
        }
    }
}
