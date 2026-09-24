package com.pandawufu.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.pandawufu.app.ui.AppNav
import com.pandawufu.app.ui.designsystem.PandaWufuTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppModule.initRedline()
        setContent {
            PandaWufuTheme {
                AppNav()
            }
        }
    }
}
