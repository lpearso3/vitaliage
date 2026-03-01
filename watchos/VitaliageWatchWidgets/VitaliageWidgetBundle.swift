import WidgetKit
import SwiftUI

/// Widget bundle containing all Vitaliage Watch complications.
@main
struct VitaliageWidgetBundle: WidgetBundle {
    var body: some Widget {
        ReadinessComplication()
        StepsComplication()
        HeartRateComplication()
        ReadinessIndicatorComplication()
    }
}
