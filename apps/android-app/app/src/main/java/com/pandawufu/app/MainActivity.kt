package com.pandawufu.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import com.pandawufu.app.ui.AppNav
import com.pandawufu.app.ui.designsystem.PandaWufuTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = true
        AppModule.init(applicationContext)
        setContent {
            PandaWufuTheme {
                AppNav(modifier = Modifier.fillMaxSize().statusBarsPadding())
            }
        }
    }
}
